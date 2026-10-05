import { scanAllServers } from './helpers.js'

// the purpose of cascade kill is to kill all scripts running on any server in the game
// but saving the host that you run it on for last (so that it doesn't kill itself prematurely)
/** @param {NS} ns **/
export async function main(ns) {
    var startingNode = ns.getHostname();
    const serverList = scanAllServers(ns);

    // The classic scan() graph never includes darkweb hosts: they live on the
    // separate ns.dnet darknet graph. Kill those first (before the classic
    // loop) so self-replicating darknet workers can't re-seed while we clean.
    await killDarknetScripts(ns);

    // Send the kill command to all servers
    for (const server of serverList) {
        // skip if this host, we save it for last
        if (server == startingNode)
            continue;

        // skip if not running anything
        if (ns.ps(server) === 0)
            continue;

        // kill all scripts
        ns.killall(server);
    }

    // idle for things to die
    for (const server of serverList) {
        // skip if this host, we save it for last
        if (server == startingNode)
            continue;
        // idle until they're dead, this is to avoid killing the cascade before it's finished.
        while (ns.ps(server) > 0) {
            await ns.sleep(20);
        }
        // Remove script files the daemon would have copied over (in case we update the source)
        for (let file of ns.ls(server, '.js'))
            ns.rm(file, server)
    }

    // wait to kill these. This kills itself, obviously.
    ns.killall(startingNode);
}

/** Kill scripts on darkweb hosts, which scanAllServers(ns) never returns.
 * probe() only lists neighbors of the current host, so a single pass from
 * home can't enumerate the deep net. Instead, cascade: exec a tiny killer on
 * each reachable darknet host that kills its local processes, cleans its .js
 * files, and execs itself onward to its own neighbors (visited-set caps the
 * flood on the mutating graph). Best-effort: hosts that need auth we don't
 * have, or that move/offline mid-cascade, are skipped with a log line. */
async function killDarknetScripts(ns) {
    if (!ns.dnet) return;
    if (!ns.scan('home').includes('darkweb')) return; // No TOR: no darknet to clean
    const killer = '/Temp/darknet-kill-cascade.js';
    const killerCode = `export async function main(ns) {
        const visited = new Set(ns.args.map(String));
        const host = ns.getHostname();
        visited.add(host);
        // Replicate first: this instance kills itself in the next step, so
        // onward execs must already be queued (scp needs no session *from* us).
        let neighbors = [];
        try { neighbors = ns.dnet.probe(false).filter(s => !visited.has(s)); } catch { neighbors = []; }
        for (const next of neighbors) {
            visited.add(next);
            try {
                await ns.scp(ns.getScriptName(), next, host);
                ns.exec(ns.getScriptName(), next, { threads: 1, preventDuplicates: true }, ...[...visited]);
            } catch { /* Auth/session missing or host moved: skip */ }
        }
        for (const proc of ns.ps(host)) { try { ns.kill(proc.pid); } catch { } }
        for (const file of ns.ls(host, '.js')) { try { ns.rm(file, host); } catch { } }
    }`;
    try {
        await ns.write(killer, killerCode, 'w');
    } catch { return; }
    // Authenticate to darkweb (empty password) so we get a session for exec/scp.
    try {
        const auth = await ns.dnet.authenticate('darkweb', '', 0);
        if (!auth.success) {
            ns.print(`WARN: kill-all-scripts: could not authenticate to darkweb (${auth.message}); skipping darknet kill.`);
            return;
        }
    } catch (e) {
        ns.print(`WARN: kill-all-scripts: darkweb authenticate threw (${e?.message ?? e}); skipping darknet kill.`);
        return;
    }
    try {
        await ns.scp(killer, 'darkweb', ns.getHostname());
    } catch {
        ns.print('WARN: kill-all-scripts: could not copy darknet killer to darkweb; skipping darknet kill.');
        return;
    }
    const pid = ns.exec(killer, 'darkweb', { threads: 1, preventDuplicates: false }, 'darkweb');
    if (pid <= 0) {
        ns.print('WARN: kill-all-scripts: could not start darknet killer on darkweb (no RAM?); skipping darknet kill.');
        return;
    }
    // Give the cascade a moment to flood the reachable net before the classic
    // loop proceeds. Workers it misses (moved/offline hosts) die on next run.
    await ns.sleep(1000);
}