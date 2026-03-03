// 0) Data + helpers
function seedClients() {
    return [
        { id: 'C001', name: 'Redwood Infrastructure', 'calculated-risk': 0, deposit_30d_pct: -20, util_pct: 88, inflow_outflow_ratio: 0.72, util_2w_delta: 11, fx_30d_pct: 3.2, revenue_bucket: 'HIGH', days_since_contact: 56, floating_rate: true, notes: 'Severe stress across liquidity and utilization.', email: 'Subject: Urgent risk review\\nHi Redwood Infrastructure team, recent account movement indicates elevated stress and requires immediate review of liquidity and funding options.' },
        { id: 'C002', name: 'Amber Industrial', 'calculated-risk': 0, deposit_30d_pct: -10, util_pct: 72, inflow_outflow_ratio: 0.9, util_2w_delta: 6, fx_30d_pct: 1.3, revenue_bucket: 'MEDIUM', days_since_contact: 35, floating_rate: true, notes: 'Moderate stress profile; proactive engagement recommended.', email: 'Subject: Check-in on account trends\\nHi Amber Industrial team, we would like to review recent utilization and cash-flow trends and align on next-step planning.' },
        { id: 'C003', name: 'Greenfield Analytics', 'calculated-risk': 0, deposit_30d_pct: 9, util_pct: 31, inflow_outflow_ratio: 1.26, util_2w_delta: -2, fx_30d_pct: -0.6, revenue_bucket: 'LOW', days_since_contact: 8, floating_rate: false, notes: 'Stable profile with low current stress.', email: 'Subject: Routine relationship touchpoint\\nHi Greenfield Analytics team, your current profile looks stable; sharing a regular check-in and support availability.' },
        { id: 'C017', name: 'Stellar Analytics', 'calculated-risk': 0, deposit_30d_pct: 5, util_pct: 42, inflow_outflow_ratio: 1.12, util_2w_delta: 0, fx_30d_pct: -0.6, revenue_bucket: 'LOW', days_since_contact: 15, floating_rate: false, notes: 'Stable, low stress profile', email: 'Subject: Relationship check-in\\nHi Stellar Analytics, steady performance noted. Here to support if needs evolve.' },
    ];
}

function nowISO() {
    return new Date().toISOString();
}

function clamp(x, min, max) {
    return Math.min(Math.max(x, min), max);
}

function normalize(value, min, max) {
    if (max === min) return 0;
    return clamp((value - min) / (max - min), 0, 1);
}

// 5) Minimal in-memory DB
const database = {
    object1: {
        type: 'object',
        description: 'In-memory RM portfolio database',
        properties: {
            clients: seedClients(),
            lastRanked: [],
            tasks: [],
            audit: {},
            alerts: [],
        },
    },
};

const clients = database.object1.properties.clients;
const lastRanked = database.object1.properties.lastRanked;
const tasks = database.object1.properties.tasks;
const audit = database.object1.properties.audit;
const alerts = database.object1.properties.alerts;

function rankClients(inputClients) {
    return inputClients
        .map((c) => {
            const score = computeClientScore(c);
            return {
                ...c,
                'calculated-risk': score.calculatedRisk,
                priorityScore: score.priorityScore,
                subscores: score.subscores,
                drivers: score.drivers,
                confidence: score.confidence,
            };
        })
        .sort((a, b) => {
            if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
            return a.id.localeCompare(b.id);
        })
        .map((c, idx) => ({ ...c, rank: idx + 1 }));
}

function replaceArrayContents(target, next) {
    target.length = 0;
    target.push(...next);
}

// 1) Scoring (core engine)
// Computes short-term liquidity pressure from deposits, utilization, and cash flow balance.
// Higher output means a client is showing stronger stress signals in day-to-day liquidity.
function computeLiquidityStress(c) {
    const depositStress = normalize(-(c.deposit_30d_pct ?? 0), 0, 20);
    const utilStress = normalize(c.util_pct ?? 0, 40, 95);
    const flowStress = normalize((1 - (c.inflow_outflow_ratio ?? 1)), 0, 0.35);
    return clamp((depositStress * 0.4 + utilStress * 0.35 + flowStress * 0.25) * 100, 0, 100);
}

// Computes credit stress from current utilization and recent acceleration in utilization.
// It emphasizes clients that are already highly utilized and still trending upward.
function computeCreditStress(c) {
    const utilStress = normalize(c.util_pct ?? 0, 45, 95);
    const deltaStress = normalize(c.util_2w_delta ?? 0, 0, 12);
    return clamp((utilStress * 0.65 + deltaStress * 0.35) * 100, 0, 100);
}

// Estimates revenue opportunity from recent FX movement and client size bucket.
// Larger buckets and stronger FX movement produce higher opportunity scores.
function computeRevenueOpportunity(c) {
    const fxOpportunity = normalize(Math.abs(c.fx_30d_pct ?? 0), 0, 4);
    const bucketMultiplier = c.revenue_bucket === 'HIGH' ? 1 : c.revenue_bucket === 'MEDIUM' ? 0.75 : 0.55;
    return clamp(fxOpportunity * bucketMultiplier * 100, 0, 100);
}

// Scores engagement urgency using time since last touchpoint.
// The longer a client goes without contact, the higher the urgency.
function computeEngagementUrgency(c) {
    return clamp(normalize(c.days_since_contact ?? 0, 0, 60) * 100, 0, 100);
}

// Produces a deterministic confidence level for the score based on data completeness and stability.
// Missing fields and large short-term swings reduce confidence.
function computeConfidence(c) {
    const required = [
        'deposit_30d_pct',
        'util_pct',
        'inflow_outflow_ratio',
        'util_2w_delta',
        'fx_30d_pct',
        'days_since_contact',
        'revenue_bucket',
    ];

    const missingCount = required.filter((k) => c[k] === undefined || c[k] === null).length;
    const missingPenalty = missingCount * 0.08;
    const volatilityPenalty = normalize(Math.abs(c.util_2w_delta ?? 0), 0, 15) * 0.12
        + normalize(Math.abs(c.fx_30d_pct ?? 0), 0, 5) * 0.08;
    const confidence = 1 - missingPenalty - volatilityPenalty;
    return clamp(confidence, 0.2, 1);
}

// Calculates overall client risk (0-100) from stress subscores and confidence.
// Higher values indicate higher current risk requiring banker attention.
function calculateRisk(c) {
    const liquidity = computeLiquidityStress(c);
    const credit = computeCreditStress(c);
    const engagement = computeEngagementUrgency(c);
    const confidence = computeConfidence(c);
    const baseRisk = liquidity * 0.45 + credit * 0.4 + engagement * 0.15;
    return Number(clamp(baseRisk * (0.9 + (1 - confidence) * 0.1), 0, 100).toFixed(2));
}

// Combines all sub-scores into a priority score and returns top narrative drivers.
// Output format is stable for ranking, UI display, and audit explanations.
function computeClientScore(c) {
    const liquidity = computeLiquidityStress(c);
    const credit = computeCreditStress(c);
    const revenueOpp = computeRevenueOpportunity(c);
    const engagement = computeEngagementUrgency(c);
    const confidence = computeConfidence(c);

    const calculatedRisk = calculateRisk(c);
    const weightedPriority = liquidity * 0.35 + credit * 0.3 + revenueOpp * 0.15 + engagement * 0.2;
    const priorityScore = clamp((weightedPriority * 0.45) + (calculatedRisk * 0.55), 0, 100);

    const candidateDrivers = [
        { score: liquidity, text: `Liquidity pressure: deposits ${c.deposit_30d_pct}% and flow ratio ${c.inflow_outflow_ratio}.` },
        { score: credit, text: `Credit pressure: utilization ${c.util_pct}% with 2w delta ${c.util_2w_delta}.` },
        { score: revenueOpp, text: `Revenue potential: FX moved ${c.fx_30d_pct}% for ${c.revenue_bucket} bucket client.` },
        { score: engagement, text: `Engagement urgency: ${c.days_since_contact} days since last contact.` },
    ];

    const drivers = candidateDrivers
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((d) => d.text);

    return {
        priorityScore: Number(priorityScore.toFixed(2)),
        subscores: {
            liquidity: Number(liquidity.toFixed(2)),
            credit: Number(credit.toFixed(2)),
            revenueOpp: Number(revenueOpp.toFixed(2)),
            engagement: Number(engagement.toFixed(2)),
        },
        drivers,
        confidence: Number(confidence.toFixed(2)),
        calculatedRisk,
    };
}

// 2) Ranking + diff
function recomputePortfolio(inputClients) {
    const rankedClients = rankClients(inputClients);
    const diff = diffRankings(lastRanked, rankedClients);
    const snapshot = computeSnapshot(rankedClients, lastRanked);
    const nextAlerts = diff.enteredTop3.map((clientId) => {
        const client = rankedClients.find((c) => c.id === clientId);
        return {
            at: nowISO(),
            clientId,
            type: 'ENTERED_TOP3',
            message: `${client ? client.name : clientId} entered top 3 priority clients.`,
        };
    });

    replaceArrayContents(lastRanked, rankedClients);
    replaceArrayContents(alerts, nextAlerts);
    return { rankedClients, snapshot };
}

function computeSnapshot(rankedClients, prevRanked = lastRanked) {
    const diff = diffRankings(prevRanked, rankedClients);
    return {
        totalClients: rankedClients.length,
        highRiskCount: rankedClients.filter((c) => c.priorityScore >= 70).length,
        mediumRiskCount: rankedClients.filter((c) => c.priorityScore >= 40 && c.priorityScore < 70).length,
        noContactOver30Count: rankedClients.filter((c) => c.days_since_contact > 30).length,
        newAlertsCount: diff.enteredTop3.length,
    };
}

function diffRankings(prevRanked, nextRanked) {
    const prevMap = new Map(prevRanked.map((c) => [c.id, c]));
    const nextTop3 = nextRanked.filter((c) => c.rank <= 3).map((c) => c.id);
    const prevTop3 = prevRanked.filter((c) => c.rank <= 3).map((c) => c.id);
    const enteredTop3 = nextTop3.filter((id) => !prevTop3.includes(id));
    const top3Changed = nextTop3.join('|') !== prevTop3.join('|');

    const topMovers = nextRanked
        .map((c) => {
            const prev = prevMap.get(c.id);
            if (!prev) {
                return {
                    clientId: c.id,
                    rankDelta: 0,
                    scoreDelta: c.priorityScore,
                };
            }

            return {
                clientId: c.id,
                rankDelta: prev.rank - c.rank,
                scoreDelta: Number((c.priorityScore - prev.priorityScore).toFixed(2)),
            };
        })
        .sort((a, b) => {
            const rankMove = Math.abs(b.rankDelta) - Math.abs(a.rankDelta);
            if (rankMove !== 0) return rankMove;
            return Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta);
        })
        .slice(0, 5);

    return {
        topMovers,
        top3Changed,
        enteredTop3,
    };
}

// 3) Scenario simulation (transforms)
function applyScenarioToClient(c, scenarioType, magnitude) {
    const next = { ...c };

    if (scenarioType === 'RATE_UP_BPS') {
        const bps = magnitude ?? 100;
        if (next.floating_rate) {
            const utilBump = (bps / 100) * 2;
            const deltaBump = (bps / 100) * 1;
            next.util_pct = clamp((next.util_pct ?? 0) + utilBump, 0, 100);
            next.util_2w_delta = (next.util_2w_delta ?? 0) + deltaBump;
        }
        return next;
    }

    if (scenarioType === 'DEPOSIT_SHOCK_PCT') {
        const shockPct = magnitude ?? -20;
        next.deposit_30d_pct = (next.deposit_30d_pct ?? 0) + shockPct;
        next.inflow_outflow_ratio = clamp((next.inflow_outflow_ratio ?? 1) * (1 + shockPct / 100), 0, 5);
        return next;
    }

    return next;
}

function runScenario(inputClients, scenarioType, magnitude) {
    const transformed = inputClients.map((c) => applyScenarioToClient(c, scenarioType, magnitude));
    const rankedClients = rankClients(transformed);
    const snapshot = computeSnapshot(rankedClients, lastRanked);
    const diff = diffRankings(lastRanked, rankedClients);
    return { rankedClients, snapshot, diff };
}

// 3b) Client-level simulation outputs for UI
function signalOf(c) {
    return c.rawSignals || c;
}

function revenueBucketOf(c) {
    const s = signalOf(c);
    return s.revenue_bucket || 'LOW';
}

function revenueAmountOf(c) {
    const bucket = revenueBucketOf(c);
    if (bucket === 'HIGH') return 12600000;
    if (bucket === 'MEDIUM') return 4800000;
    return 1200000;
}

function simulationRiskScore(c) {
    const s = signalOf(c);
    const depositStress = Math.max(0, -(s.deposit_30d_pct ?? 0)) * 2.2;
    const utilStress = Math.max(0, (s.util_pct ?? 0) - 50) * 1.15;
    const flowStress = Math.max(0, (1 - (s.inflow_outflow_ratio ?? 1)) * 90);
    const accelStress = Math.max(0, s.util_2w_delta ?? 0) * 1.9;
    const fxStress = Math.abs(s.fx_30d_pct ?? 0) * 3.8;
    const contactStress = Math.max(0, (s.days_since_contact ?? 0) - 14) * 0.55;
    const floatStress = s.floating_rate ? 3 : 0;
    return Math.round(clamp(10 + depositStress + utilStress + flowStress + accelStress + fxStress + contactStress + floatStress, 0, 100));
}

function formatCurrency(value) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
    }).format(value);
}

function simulatePriorityScoring(c) {
    const score = simulationRiskScore(c);
    const s = signalOf(c);
    return {
        title: 'Client Priority Scoring',
        summary: `${c.name} composite stress score for current state.`,
        metrics: [
            { label: 'Current Client Score', value: `${score}/100` },
            { label: 'Severity Band', value: `${score >= 70 ? 'High' : score >= 45 ? 'Medium' : 'Low'}` },
            { label: 'Days Since Contact', value: `${s.days_since_contact}` },
        ],
        highlights: [
            `Deposit trend: ${s.deposit_30d_pct}%`,
            `Utilization: ${s.util_pct}%`,
            `Flow ratio: ${s.inflow_outflow_ratio}`,
        ],
    };
}

function simulateOutreachQueue(c) {
    const score = simulationRiskScore(c);
    const s = signalOf(c);
    const outreachScore = Math.round(score + ((s.days_since_contact ?? 0) * 0.6) + (revenueAmountOf(c) / 2000000));
    return {
        title: 'Outreach Queue',
        summary: 'Current-client outreach recommendation based on urgency and inactivity.',
        metrics: [
            { label: 'Outreach Score', value: `${outreachScore}` },
            { label: 'Recommended SLA', value: `${(s.days_since_contact ?? 0) > 30 || score >= 70 ? 'Call within 24h' : 'Call within 3 days'}` },
            { label: 'Suggested Channel', value: `${score >= 65 ? 'Call + Email' : 'Email first'}` },
        ],
        highlights: [`${c.name}: ${s.days_since_contact}d since last contact`],
    };
}

function simulateRiskEscalation(c) {
    const s = signalOf(c);
    const base = simulationRiskScore(c);
    const drift = Math.max(0, -(s.deposit_30d_pct ?? 0)) * 0.4
        + Math.max(0, s.util_2w_delta ?? 0) * 0.9
        + ((s.inflow_outflow_ratio ?? 1) < 1 ? (1 - (s.inflow_outflow_ratio ?? 1)) * 8 : 0);
    const d30 = Math.round(clamp(base + drift, 0, 100));
    const d60 = Math.round(clamp(base + (drift * 1.7), 0, 100));
    const d90 = Math.round(clamp(base + (drift * 2.3), 0, 100));
    return {
        title: 'Risk Escalation (30/60/90)',
        summary: 'Forward risk projection based on current stress direction.',
        metrics: [
            { label: 'Today', value: `${base}/100` },
            { label: '30 Days', value: `${d30}/100` },
            { label: '60 Days', value: `${d60}/100` },
            { label: '90 Days', value: `${d90}/100` },
        ],
        highlights: [`Escalation velocity: ${d90 - base >= 12 ? 'High' : d90 - base >= 6 ? 'Moderate' : 'Low'}`],
    };
}

function simulateWhatIfMitigation(c) {
    const base = simulationRiskScore(c);
    const s = signalOf(c);
    const options = [
        { label: 'Liquidity restructuring call', reduction: 8 },
        { label: 'Working-capital facility tune-up', reduction: 6 },
        { label: 'FX hedge review', reduction: (s.fx_30d_pct ?? 0) ? 4 : 2 },
    ];
    return {
        title: 'What-If Mitigation',
        summary: 'Estimated score impact if interventions are executed in the next 7 days.',
        metrics: [{ label: 'Baseline Risk', value: `${base}/100` }],
        highlights: options.map((o) => `${o.label}: ${Math.round(clamp(base - o.reduction, 0, 100))}/100`),
    };
}

function simulateRevenueAtRisk(c) {
    const score = simulationRiskScore(c);
    const annualRevenue = revenueAmountOf(c);
    const riskProbability = clamp((score / 100) * 0.85, 0.05, 0.95);
    const expectedAtRisk = annualRevenue * riskProbability;
    return {
        title: 'Revenue at Risk',
        summary: 'Expected value model linking relationship stress to commercial exposure.',
        metrics: [
            { label: 'Annual Revenue', value: formatCurrency(annualRevenue) },
            { label: 'Stress Probability', value: `${Math.round(riskProbability * 100)}%` },
            { label: 'Expected Revenue at Risk', value: formatCurrency(expectedAtRisk) },
        ],
        highlights: [`Revenue bucket: ${revenueBucketOf(c)}`],
    };
}

function simulateRelationshipNeglect(c) {
    const base = simulationRiskScore(c);
    const s = signalOf(c);
    const cadence = [
        { name: 'Weekly touchpoint', lift: 1.5 },
        { name: 'Biweekly touchpoint', lift: 4.5 },
        { name: 'Monthly touchpoint', lift: 9.5 },
    ];
    return {
        title: 'Relationship Neglect',
        summary: `Risk uplift if no contact policy is adjusted (currently ${s.days_since_contact} days since contact).`,
        metrics: [{ label: 'Current Risk', value: `${base}/100` }],
        highlights: cadence.map((row) => `${row.name}: ${Math.round(clamp(base + row.lift, 0, 100))}/100 projected`),
    };
}

function simulateRateFxStress(c) {
    const base = simulationRiskScore(c);
    const s = signalOf(c);
    const rateShock = Math.round(clamp(base + (s.floating_rate ? 9 : 3), 0, 100));
    const fxShock = Math.round(clamp(base + (Math.abs(s.fx_30d_pct ?? 0) > 1.5 ? 8 : 4), 0, 100));
    const combined = Math.round(clamp(base + (s.floating_rate ? 11 : 6) + (Math.abs(s.fx_30d_pct ?? 0) > 1.5 ? 7 : 3), 0, 100));
    return {
        title: 'Rate / FX Stress Test',
        summary: 'Scenario test under adverse market movements.',
        metrics: [
            { label: 'Base', value: `${base}/100` },
            { label: 'Rate +200bps', value: `${rateShock}/100` },
            { label: 'FX +3%', value: `${fxShock}/100` },
            { label: 'Combined Shock', value: `${combined}/100` },
        ],
        highlights: [],
    };
}

function simulateContactEffectiveness(c) {
    const score = simulationRiskScore(c);
    const s = signalOf(c);
    const urgency = score >= 75 ? 'High' : score >= 55 ? 'Medium' : 'Low';
    const callProb = clamp(0.4 + ((s.days_since_contact ?? 0) > 30 ? 0.15 : 0) + (urgency === 'High' ? 0.2 : 0), 0.2, 0.92);
    const emailProb = clamp(0.35 + (urgency === 'Low' ? 0.15 : 0.05), 0.2, 0.85);
    const comboProb = clamp(callProb + 0.08, 0.25, 0.95);
    return {
        title: 'Contact Effectiveness',
        summary: `Predicted engagement by contact strategy (${urgency} urgency).`,
        metrics: [
            { label: 'Email Only', value: `${Math.round(emailProb * 100)}%` },
            { label: 'Call Only', value: `${Math.round(callProb * 100)}%` },
            { label: 'Email + Call', value: `${Math.round(comboProb * 100)}%` },
        ],
        highlights: ['Best strategy: Email + Call within 48 hours'],
    };
}

function simulatePortfolioHeatmap(c) {
    const score = simulationRiskScore(c);
    const bucket = revenueBucketOf(c);
    const band = score >= 70 ? 'High' : score >= 45 ? 'Medium' : 'Low';
    return {
        title: 'Portfolio Heatmap (Client View)',
        summary: 'Current client mapped to revenue segment and risk band.',
        metrics: [
            { label: 'Client Revenue Bucket', value: bucket },
            { label: 'Risk Band', value: band },
            { label: 'Current Client Risk', value: `${score}/100` },
        ],
        highlights: [`${c.name} sits in ${bucket} revenue / ${band} risk quadrant.`],
    };
}

function simulateEarlyWarningBacktest(c) {
    const s = signalOf(c);
    const triggered = (s.deposit_30d_pct ?? 0) <= -10
        || ((s.util_2w_delta ?? 0) >= 5 && (s.inflow_outflow_ratio ?? 1) < 0.95)
        || ((s.days_since_contact ?? 0) > 40 && (s.util_pct ?? 0) > 70);
    const actualHigh = simulationRiskScore(c) >= 70;
    return {
        title: 'Early Warning Rule Check',
        summary: 'Rule evaluation for the current client only.',
        metrics: [
            { label: 'Rule Triggered', value: triggered ? 'Yes' : 'No' },
            { label: 'Modeled High Risk', value: actualHigh ? 'Yes' : 'No' },
            { label: 'Alignment', value: triggered === actualHigh ? 'Match' : 'Mismatch' },
        ],
        highlights: ['Rule: deposit <= -10 OR (util delta >= 5 and flow ratio < 0.95) OR (days since contact > 40 and util > 70)'],
    };
}

const SIMULATION_RUNNERS = {
    priority: simulatePriorityScoring,
    outreach: simulateOutreachQueue,
    escalation: simulateRiskEscalation,
    mitigation: simulateWhatIfMitigation,
    revenueAtRisk: simulateRevenueAtRisk,
    neglect: simulateRelationshipNeglect,
    stress: simulateRateFxStress,
    effectiveness: simulateContactEffectiveness,
    heatmap: simulatePortfolioHeatmap,
    backtest: simulateEarlyWarningBacktest,
};

function runClientSimulation(client, simulationId) {
    const run = SIMULATION_RUNNERS[simulationId];
    if (!run) return null;
    return run(client);
}

// 4) Tasks + audit log
function createTask({ clientId, description, dueDate }) {
    const task = { id: `T${tasks.length + 1}`, clientId, description, dueDate, createdAt: nowISO() };
    tasks.push(task);
    return task;
}

function listTasks() {
    return tasks;
}

function addAuditLog(clientId, auditdescription) {
    if (!clientId || typeof auditdescription !== 'string') {
        return null;
    }

    if (!audit[clientId]) {
        audit[clientId] = [];
    }

    const entry = {
        at: nowISO(),
        clientId,
        auditdescription,
    };

    audit[clientId].push(entry);
    return entry;
}

function logAudit(clientId, auditdescription) {
    return addAuditLog(clientId, auditdescription);
}

function seedC017EventDrivenProfile() {
    const client = clients.find((c) => c.id === 'C017');
    if (!client) return;

    const seedEvents = [
        { eventType: 'DEPOSIT_30D_PCT', magnitude: -12 },
        { eventType: 'UTIL_PCT', magnitude: 18 },
        { eventType: 'DAYS_SINCE_CONTACT', magnitude: 22 },
        { eventType: 'FX_30D_PCT', magnitude: 1.4 },
    ];

    for (const evt of seedEvents) {
        if (evt.eventType === 'DEPOSIT_30D_PCT') {
            client.deposit_30d_pct += Number(evt.magnitude);
        } else if (evt.eventType === 'UTIL_PCT') {
            client.util_pct = clamp(client.util_pct + Number(evt.magnitude), 0, 100);
        } else if (evt.eventType === 'DAYS_SINCE_CONTACT') {
            client.days_since_contact = Math.max(0, client.days_since_contact + Number(evt.magnitude));
        } else if (evt.eventType === 'FX_30D_PCT') {
            client.fx_30d_pct += Number(evt.magnitude);
        }

        addAuditLog(
            client.id,
            `Seed event ${evt.eventType} applied with magnitude ${evt.magnitude}`
        );
    }

    client['calculated-risk'] = calculateRisk(client);
    client.notes =
        `Event-seeded profile: deposits now ${client.deposit_30d_pct}% (30d), utilization ${client.util_pct}%, ` +
        `${client.days_since_contact} days since contact, FX ${client.fx_30d_pct}%. ` +
        'Escalate outreach this week and validate liquidity plan.';
    client.email =
        'Subject: Action needed on recent account movement\\n' +
        `Hi ${client.name} team, recent account movement shows lower deposits (${client.deposit_30d_pct}% over 30 days) and higher utilization (${client.util_pct}%). ` +
        'I would like to schedule a 20-minute review this week to discuss liquidity options and near-term funding actions.';
}

function listAudit(limit = 20, clientId) {
    if (clientId) {
        return (audit[clientId] || []).slice(-limit).reverse();
    }

    const allEntries = Object.values(audit).flat();
    return allEntries.slice(-limit).reverse();
}

seedC017EventDrivenProfile();

module.exports = {
    database,
    clients,
    lastRanked,
    tasks,
    audit,
    alerts,
    seedClients,
    nowISO,
    clamp,
    normalize,
    computeLiquidityStress,
    computeCreditStress,
    computeRevenueOpportunity,
    computeEngagementUrgency,
    computeConfidence,
    calculateRisk,
    computeClientScore,
    recomputePortfolio,
    computeSnapshot,
    diffRankings,
    applyScenarioToClient,
    runScenario,
    runClientSimulation,
    createTask,
    listTasks,
    addAuditLog,
    logAudit,
    listAudit,
};
