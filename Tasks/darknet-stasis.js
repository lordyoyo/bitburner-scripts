/** @param {NS} ns
 * Darknet stasis-link helper. Applies a stasis link to the current server so it
 * stops moving/going offline and stays reachable via connectToSession/exec/terminal.
 * Kept dependency-free (no helpers.js import) so it stays small on tiny darknet servers. **/
export async function main(ns) {
    const shouldLink = ns.args.length === 0 ? true : Boolean(ns.args[0]);
    if (!ns.dnet) return;
    try {
        const result = await ns.dnet.setStasisLink(shouldLink);
        ns.print(`${shouldLink ? 'Apply' : 'Remove'} stasis link on ${ns.getHostname()}: ${result.message} (${result.code})`);
    } catch (error) {
        ns.print(`WARN: Stasis link helper failed on ${ns.getHostname()}: ${formatError(error)}`);
    }
}

function formatError(error) {
    if (typeof error === 'string') return error;
    return error?.message ?? JSON.stringify(error);
}
