import {
    instanceCount, getConfiguration, getFilePath, log,
    formatMoney, formatRam
} from './helpers.js'

const TOR_COST_DISPLAY = 200e3; //TOR cost needs to be hardcoded because the API doesn't expose the live price (getDarkwebProgramCost() returns -1 without TOR)
const NAVIGATOR_COST_DISPLAY_FALLBACK = 50e6; //fallback display price for DarkscapeNavigator.exe (live price is via getDarkwebProgramCost() once TOR exists)
const NAVIGATOR_PROGRAM = 'DarkscapeNavigator.exe';

let options; // Set in main() once we're sure this is the only running instance (house pattern: stockmaster.js, bladeburner.js)

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
    ['req-check-interval', 10000], // How often to re-check TOR/exe/money while waiting for requirements (ms)
    ['reserve', null], // Override reserve.txt: amount of money to leave unspent when auto-purchasing
    ['disable-purchase-tor', false], // If set, wait for the user to buy TOR manually (mirrors stockmaster --disable-purchase-tix-api)
    ['disable-purchase-exe', false], // If set, wait for the user to buy DarkscapeNavigator.exe manually
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
 * Persistent like stockmaster.js: if requirements are missing, waits, auto-buys them
 * when affordable (respecting reserve.txt), and re-checks periodically instead of exiting.
 * @param {NS} ns **/
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
    if (options['no-tail-windows']) ns.disableLog('ALL');
    if (!ns.dnet)
        return log(ns, 'ERROR: ns.dnet is unavailable (old game version without Bitburner 3.0 darknet API). Update the game, then rerun.', true, 'error');
    const worker = getFilePath(String(options.worker));
    if (!ns.fileExists(worker, 'home'))
        return log(ns, `ERROR: Missing worker ${worker} on home. Reinstall scripts, then rerun.`, true, 'error');
    // Stay alive until TOR + DarkscapeNavigator.exe are owned (buying them if we can).
    await ensureDarknetReady(ns, options);
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
                // Network mutates often; don't give up, go back to waiting for requirements.
                ns.print(`INFO: ${darkweb} is not a darknet server right now. Re-checking requirements...`);
                await ensureDarknetReady(ns, options);
                continue;
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

/** Wait (persistently) until TOR + DarkscapeNavigator.exe are both owned.
 * On each tick: check if met -> try to make it met (auto-buy if affordable) -> else sleep and re-check.
 * Only exits once requirements are met, so callers never have to relaunch us (daemon.js parity with stockmaster.js).
 * Only requirements that can change during a normal daemon.js run are polled here (ownership + money).
 * @param {NS} ns */
async function ensureDarknetReady(ns, options) {
    const reqCheckInterval = Math.max(1000, Number(options['req-check-interval']) || 10000);
    const darkweb = 'darkweb';
    let misses = 0;
    while (true) {
        try {
            const hasTor = ns.scan('home').includes(darkweb);
            const hasExe = ns.fileExists('DarkscapeNavigator.exe', 'home');
            const unlocked = hasTor && hasExe && safeIsDarknetServer(ns, darkweb);
            if (unlocked) {
                if (misses > 0) // Only noisy if we previously waited (stockmaster-style feedback)
                    log(ns, `SUCCESS: Darknet requirements met (TOR + DarkscapeNavigator.exe). Starting crawler.`, true, 'success');
                return true;
            }
            misses++;
            const money = ns.getPlayer().money;
            const reserve = getSpendReserve(ns, options);
            const budget = Math.max(0, money - reserve);
            // Try to make requirements met: TOR first (exe needs TOR), then the exe. Same loop handles user manual buys.
            // program-manager.js pattern: the purchase call itself is programmatic (game is source of truth);
            // cost values below are only for reserve math + wait messages, never a gate that blocks a purchase attempt.
            if (!hasTor) {
                if (!options['disable-purchase-tor'] && budget > 0 && tryPurchaseTor(ns)) {
                    log(ns, `SUCCESS: Purchased TOR router.`, true, 'success');
                    continue; // Re-check immediately: exe may be next
                }
                throttledWaitLog(ns, options, misses,
                    `INFO: Waiting for TOR router (standard price ${formatMoney(TOR_COST_DISPLAY)} — no API exposes the live price). ` +
                    `Money ${formatMoney(money)} (budget ${formatMoney(budget)} after ${formatMoney(reserve)} reserve). ` +
                    (options['disable-purchase-tor'] ? `Auto-buy disabled (--disable-purchase-tor). Buy TOR manually from the city.`
                        : budget <= 0 ? `Will auto-buy once affordable (e.g. after a casino run).`
                        : `Purchase attempt failed (needs Singularity access, funds, or manual buy). Will retry.`) +
                    ` Re-checking every ${Math.round(reqCheckInterval / 1000)}s.`);
            } else if (!hasExe) {
                const exeCost = getNavigatorCost(ns); // Live `buy -l` price via getDarkwebProgramCost, fallback display pre-query
                const exeCostKnown = exeCost.known;
                if (!options['disable-purchase-exe'] && budget > 0 && tryPurchaseProgram(ns, NAVIGATOR_PROGRAM)) {
                    log(ns, `SUCCESS: Purchased ${NAVIGATOR_PROGRAM}${exeCostKnown ? ` for ${formatMoney(exeCost.value)}` : ''}.`, true, 'success');
                    continue; // Re-check immediately: should now be unlocked
                }
                throttledWaitLog(ns, options, misses,
                    `INFO: Waiting for ${NAVIGATOR_PROGRAM} (${exeCostKnown ? `live price ${formatMoney(exeCost.value)}` : `standard price ~${formatMoney(exeCost.value)}`}). ` +
                    `Money ${formatMoney(money)} (budget ${formatMoney(budget)} after ${formatMoney(reserve)} reserve). ` +
                    (options['disable-purchase-exe'] ? `Auto-buy disabled (--disable-purchase-exe). Buy it from the darkweb manually.`
                        : budget <= 0 ? `Will auto-buy once affordable (e.g. after a casino run).`
                        : `Purchase attempt failed (needs Singularity access, funds, or manual buy). Will retry.`) +
                    ` Re-checking every ${Math.round(reqCheckInterval / 1000)}s.`);
            } else {
                // Own both but darkweb not (yet) visible as a darknet server. Re-check, don't exit.
                throttledWaitLog(ns, options, misses,
                    `INFO: Waiting for ${darkweb} to be reachable as a darknet server (TOR + exe owned). Re-checking every ${Math.round(reqCheckInterval / 1000)}s.`);
            }
        } catch (error) {
            ns.print(`WARN: Darknet requirements check failed: ${formatError(error)} (will retry)`);
        }
        await ns.sleep(reqCheckInterval);
    }
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

/** First miss + periodic reminders go to the log/terminal; ticks in between only go to the tail (ns.print).
 * Mirrors stockmaster.js log discipline so daemon.js tails aren't spammed while we wait for casino money. */
function throttledWaitLog(ns, options, misses, message) {
    if (misses <= 1 || misses % 6 === 0) terminalLog(ns, options, message);
    else ns.print(message);
}

/** Amount of money to leave unspent: explicit --reserve wins, else global reserve.txt (autopilot/Daedalus savings). */
function getSpendReserve(ns, options) {
    if (options.reserve != null) {
        const override = Number(options.reserve);
        if (isFinite(override) && override >= 0) return override;
    }
    const fromFile = Number(ns.read('reserve.txt') || 0);
    return isFinite(fromFile) && fromFile > 0 ? fromFile : 0;
}

/** isDarknetServer wrapper that never throws (e.g. pre-exe states); false just means "not ready yet". */
function safeIsDarknetServer(ns, host) {
    try {
        return ns.dnet.isDarknetServer(host);
    } catch { return false; }
}

/** Live `buy -l` price via getDarkwebProgramCost() once TOR exists.
 * Returns { value, known }: known=false means pre-TOR fallback display (API returns -1 without TOR). */
function getNavigatorCost(ns) {
    try {
        if (ns.scan('home').includes('darkweb')) {
            const live = ns.singularity.getDarkwebProgramCost(NAVIGATOR_PROGRAM);
            if (isFinite(live) && live > 0) return { value: live, known: true };
            if (live === 0) return { value: 0, known: true }; // Already owned (race with manual buy)
        }
    } catch { /* No Singularity/TOR yet: fall through to fallback display */ }
    return { value: NAVIGATOR_COST_DISPLAY_FALLBACK, known: false };
}

/** purchaseTor wrapper: false on no-Singularity / failure so we fall back to waiting for a manual buy. */
function tryPurchaseTor(ns) {
    try {
        if (ns.scan('home').includes('darkweb')) return true; // Raced with tor-manager.js / manual buy
        return ns.singularity.purchaseTor();
    } catch { return false; }
}

/** purchaseProgram wrapper: true if already owned or bought now; false otherwise. */
function tryPurchaseProgram(ns, program) {
    try {
        if (ns.fileExists(program, 'home')) return true; // Raced with program-manager.js / manual buy
        return ns.singularity.purchaseProgram(program);
    } catch { return false; }
}
