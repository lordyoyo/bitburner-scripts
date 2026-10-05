import { getConfiguration, getFilePath, instanceCount, log, formatRam } from '../helpers.js'

const argsSchema = [
    ['worker', '/Tasks/darknet-worker.js'],
    ['phishing-worker', '/Tasks/darknet-phishing.js'],
    ['migration-worker', '/Tasks/darknet-migration.js'],
    ['stock-worker', '/Tasks/darknet-stock.js'],
    ['storm-worker', '/Tasks/darknet-storm.js'],
    ['stasis', '/Tasks/darknet-stasis.js'],
    ['interval', 30000],
    ['migration-interval', 60000],
    ['stock-promotion-interval', 60000],
    ['promote-stock', ''],
    ['disable-migration', false],
    ['disable-stock-promotion', false],
    ['no-tail-windows', false],
    ['verbose-terminal', false],
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** Automates initial Bitburner 3.0 darknet exploration.
 * Runs on home (launched by daemon.js): authenticates to darkweb (empty password),
 * copies the self-replicating worker + optional helpers there, and keeps them running.
 * Requires TOR + DarkscapeNavigator.exe (ns.dnet access).
 * @param {NS} ns **/
export async function main(ns) {
    const options = getConfiguration(ns, argsSchema);
    if (!options) return;
    if (await instanceCount(ns, 'home', false, false) > 1)
        return log(ns, 'Another instance is already running. Shutting down...');
    if (options['no-tail-windows']) ns.disableLog('ALL');
    if (!ns.dnet)
        return log(ns, 'INFO: ns.dnet is unavailable. Buy TOR + DarkscapeNavigator.exe before running darknet automation.');
    if (!ns.fileExists('DarkscapeNavigator.exe', 'home'))
        return log(ns, 'INFO: Darknet is not unlocked yet. Buy TOR + DarkscapeNavigator.exe before running darknet automation.');
    const worker = getFilePath(String(options.worker));
    const phishingWorker = getFilePath(String(options['phishing-worker']));
    const migrationWorker = getFilePath(String(options['migration-worker']));
    const stockWorker = getFilePath(String(options['stock-worker']));
    const stormWorker = getFilePath(String(options['storm-worker']));
    const stasis = getFilePath(String(options.stasis));
    const interval = Math.max(1000, Number(options.interval) || 30000);
    const darkweb = 'darkweb';
    let loggedWorkerAlreadyRunning = false;
    let loggedWorkerLaunchFailed = false;
    const loggedHelperStatus = {};
    while (true) {
        try {
            if (!ns.dnet.isDarknetServer(darkweb)) {
                log(ns, 'INFO: Darknet is not unlocked yet. Buy DarkscapeNavigator.exe and rerun.');
                return;
            }
            const auth = await ns.dnet.authenticate(darkweb, '', 0);
            if (!auth.success) {
                ns.print(`WARN: Could not authenticate to darkweb: ${auth.message} (${auth.code})`);
                await ns.sleep(interval);
                continue;
            }
            await ns.scp(worker, darkweb, 'home');
            if (phishingWorker && ns.fileExists(phishingWorker, 'home')) await ns.scp(phishingWorker, darkweb, 'home');
            if (!options['disable-migration'] && ns.fileExists(migrationWorker, 'home')) await ns.scp(migrationWorker, darkweb, 'home');
            if (!options['disable-stock-promotion'] && ns.fileExists(stockWorker, 'home')) await ns.scp(stockWorker, darkweb, 'home');
            if (stormWorker && ns.fileExists(stormWorker, 'home')) await ns.scp(stormWorker, darkweb, 'home');
            if (stasis && ns.fileExists(stasis, 'home')) await ns.scp(stasis, darkweb, 'home');
            if (ns.fileExists('/Temp/stock-symbols.txt', 'home')) await ns.scp('/Temp/stock-symbols.txt', darkweb, 'home');
            const workerArgs = ['--origin', 'home', '--dedicated-phishing'];
            if (options['verbose-terminal']) workerArgs.push('--verbose-terminal');
            const runningWorker = findRunningProcess(ns, darkweb, worker);
            if (runningWorker) {
                if (!loggedWorkerAlreadyRunning) terminalLog(ns, options, `INFO: ${worker} is already running on ${darkweb}.`);
                loggedWorkerAlreadyRunning = true;
                loggedWorkerLaunchFailed = false;
                await launchOptionalHelpers(ns, options, darkweb, migrationWorker, stockWorker, stormWorker, loggedHelperStatus);
                await ns.sleep(interval);
                continue;
            }
            const pid = ns.exec(worker, darkweb, { threads: 1, preventDuplicates: true }, ...workerArgs);
            if (pid > 0) {
                loggedWorkerAlreadyRunning = true;
                loggedWorkerLaunchFailed = false;
                terminalLog(ns, options, `INFO: Started ${worker} on ${darkweb} (pid ${pid}).`);
                await launchOptionalHelpers(ns, options, darkweb, migrationWorker, stockWorker, stormWorker, loggedHelperStatus);
            } else {
                if (!loggedWorkerLaunchFailed)
                    ns.print(`WARN: Failed to start ${worker} on ${darkweb}; not enough RAM or exec was rejected.`);
                loggedWorkerLaunchFailed = true;
            }
        } catch (error) {
            ns.print(`WARN: Darknet launcher failed: ${formatError(error)}`);
        }
        await ns.sleep(interval);
    }
}


function terminalLog(ns, options, message) {
    if (options['verbose-terminal']) ns.tprint(message);
    else ns.print(message);
    log(ns, message);
}

async function launchOptionalHelpers(ns, options, host, migrationWorker, stockWorker, stormWorker, loggedStatus) {
    await launchHelperIfPossible(ns, options, host, stormWorker, [
        ...(options['verbose-terminal'] ? ['--verbose-terminal'] : []),
    ], loggedStatus);
    if (!options['disable-migration'])
        await launchHelperIfPossible(ns, options, host, migrationWorker, [
            '--origin', 'home',
            '--interval', options['migration-interval'],
            ...(options['verbose-terminal'] ? ['--verbose-terminal'] : []),
        ], loggedStatus);
    if (!options['disable-stock-promotion'])
        await launchHelperIfPossible(ns, options, host, stockWorker, [
            '--origin', 'home',
            '--interval', options['stock-promotion-interval'],
            ...(options['promote-stock'] ? ['--promote-stock', String(options['promote-stock'])] : []),
            ...(options['verbose-terminal'] ? ['--verbose-terminal'] : []),
        ], loggedStatus);
}

async function launchHelperIfPossible(ns, options, host, script, args, loggedStatus) {
    if (!script || !ns.fileExists(script, host) || isRunning(ns, host, script)) return;
    const requiredRam = ns.getScriptRam(script, host);
    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    const key = `${host}:${script}`;
    if (requiredRam <= 0 || freeRam < requiredRam) {
        if (!loggedStatus[key]) {
            ns.print(`INFO: Skipping ${script} on ${host}; needs ${formatRam(requiredRam)}, free ${formatRam(freeRam)}.`);
            loggedStatus[key] = 'skipped';
        }
        return;
    }
    const pid = ns.exec(script, host, { threads: 1, preventDuplicates: true }, ...args);
    if (pid > 0) {
        loggedStatus[key] = 'started';
        terminalLog(ns, options, `INFO: Started ${script} on ${host} (pid ${pid}).`);
    }
}

function isRunning(ns, host, script) {
    return findRunningProcess(ns, host, script) != null;
}

function findRunningProcess(ns, host, script) {
    return ns.ps(host).find(process => process.filename === script || process.filename.endsWith(`/${script}`));
}

function formatError(error) {
    if (typeof error === 'string') return error;
    return error?.message ?? JSON.stringify(error);
}
