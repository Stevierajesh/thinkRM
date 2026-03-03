const express = require('express');
const path = require('path');
const portfolioEngine = require('./portfolioEngine');

const app = express();
const PORT = process.env.PORT || 3000;
const ORCHESTRATE_API_TOKEN = process.env.ORCHESTRATE_API_TOKEN;
const API_AUTH_DISABLED = false;
const WO_EVENT_WEBHOOK_URL = 'https://api.dl.watson-orchestrate.ibm.com/instances/20260219-1837-3526-008a-a64f37622ded';
const WO_EVENT_BEARER_TOKEN = process.env.WO_EVENT_BEARER_TOKEN;
const WO_CHAT_COMPLETIONS_URL = 'https://api.dl.watson-orchestrate.ibm.com/instances/20260219-1837-3526-008a-a64f37622ded/v1/orchestrate/252c45c1-2a9d-4581-9475-dfa217ab4284/chat/completions';
const WO_EVENT_API_KEY = process.env.WO_EVENT_API_KEY;
const WO_EVENT_TIMEOUT_MS = Number(process.env.WO_EVENT_TIMEOUT_MS || 5000);
const IBM_IAM_TOKEN_URL = 'https://iam.platform.saas.ibm.com/siusermgr/api/1.0/apikeys/token';
const IBM_IAM_API_KEY = process.env.IBM_IAM_API_KEY;

const ibmIamTokenCache = {
    token: null,
    tokenType: 'Bearer',
    expiresAtMs: 0,
    fetchedAtMs: 0,
};

app.use(express.json());
app.locals.portfolioEngine = portfolioEngine;
app.locals.ibmIamTokenCache = ibmIamTokenCache;
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/frontend', express.static(path.join(__dirname, '..', 'frontend')));

app.get('/openapi.yaml', (req, res) => {
    res.sendFile(path.join(__dirname, 'openapi', 'orchestrate-api.yaml'));
});

async function notifyWatsonEvent(payload) {
    if (!WO_EVENT_WEBHOOK_URL) return;

    const headers = {
        'Content-Type': 'application/json',
    };

    if (WO_EVENT_BEARER_TOKEN) {
        headers.Authorization = `Bearer ${WO_EVENT_BEARER_TOKEN}`;
    }
    if (WO_EVENT_API_KEY) {
        headers['x-api-key'] = WO_EVENT_API_KEY;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WO_EVENT_TIMEOUT_MS);

    try {
        const response = await fetch(WO_EVENT_WEBHOOK_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const body = await response.text();
            console.error(`Watson event push failed (${response.status}): ${body}`);
        }
    } catch (error) {
        console.error(`Watson event push error: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
}

async function requestDraftEmailFromWatson({ clientId, eventType, magnitude, clientData }) {
    if (!WO_CHAT_COMPLETIONS_URL) return;

    const clientSnapshot = clientData || {};
    const customerEmail = clientSnapshot.email || '';
    const content = [
        `Generate (DRAFT AN EMAIL, YOU DON'T NEED THE EMAIL ADDRESS) a professional relationship-manager email for client. just make up the situation and give me the drafted email for the client ID: ${clientId}.`,
        `The latest input-change event was ${eventType} with magnitude ${Number(magnitude)}.`,
        'Use these client datapoints:',
        `id: ${clientSnapshot.id ?? ''}`,
        `name: ${clientSnapshot.name ?? ''}`,
        `calculated-risk: ${clientSnapshot['calculated-risk'] ?? ''}`,
        `deposit_30d_pct: ${clientSnapshot.deposit_30d_pct ?? ''}`,
        `util_pct: ${clientSnapshot.util_pct ?? ''}`,
        `inflow_outflow_ratio: ${clientSnapshot.inflow_outflow_ratio ?? ''}`,
        `util_2w_delta: ${clientSnapshot.util_2w_delta ?? ''}`,
        `fx_30d_pct: ${clientSnapshot.fx_30d_pct ?? ''}`,
        `revenue_bucket: ${clientSnapshot.revenue_bucket ?? ''}`,
        `days_since_contact: ${clientSnapshot.days_since_contact ?? ''}`,
        `floating_rate: ${clientSnapshot.floating_rate ?? ''}`,
        `notes: ${clientSnapshot.notes ?? ''}`,
        `previous_email_or_recipient_field: ${clientSnapshot.email ?? ''}`,
        '',
        'Email section:',
        `To: ${customerEmail}`,
        'Subject: <short clear subject>',
        'Body: <concise customer email with clear next step>',
        '',
        'Return exactly this format: To, Subject, Body.',
    ].join('\n');
    const body = {
        messages: [
            {
                role: 'user',
                content,
            },
        ],
        stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WO_EVENT_TIMEOUT_MS);

    try {
        const tokenPayload = await getIbmIamToken({ forceRefresh: false });
        const authToken = tokenPayload?.access_token || tokenPayload?.token || null;
        if (!authToken) {
            console.error('Watson chat completion skipped: no IAM access token available.');
            return;
        }

        const response = await fetch(WO_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const responseBody = await response.text();
            console.error(`Watson chat completion failed (${response.status}): ${responseBody}`);
            return;
        }

        const result = await response.json();
        const message = result?.choices?.[0]?.message?.content;
        if (message && typeof message === 'string') {
            const targetClient = portfolioEngine.clients.find((c) => c.id === clientId);
            if (targetClient) {
                targetClient.email = message.trim();
            }
            portfolioEngine.addAuditLog(
                clientId,
                `Drafted email generated for event ${eventType}: ${message.slice(0, 220)}`
            );
        }
    } catch (error) {
        console.error(`Watson chat completion error: ${error.message}`);
    } finally {
        clearTimeout(timer);
    }
}

function requireBearerAuth(req, res, next) {
    if (API_AUTH_DISABLED || !ORCHESTRATE_API_TOKEN) {
        next();
        return;
    }

    const authHeader = req.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing Bearer token.' });
        return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (token !== ORCHESTRATE_API_TOKEN) {
        res.status(403).json({ error: 'Invalid Bearer token.' });
        return;
    }

    next();
}

app.use('/api', requireBearerAuth);

function decodeJwtExpMs(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return null;
        const payloadRaw = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(payloadRaw);
        if (!payload.exp) return null;
        return Number(payload.exp) * 1000;
    } catch {
        return null;
    }
}

function normalizeIbmIamTokenPayload(payload) {
    const token = payload.access_token || payload.token || payload.jwt || payload.id_token || null;
    const tokenType = payload.token_type || 'Bearer';
    const nowMs = Date.now();

    let expiresAtMs = 0;
    const expirationCandidate = payload.expiration ?? payload.expires_at;
    if (expirationCandidate !== undefined && expirationCandidate !== null) {
        const n = Number(expirationCandidate);
        if (Number.isFinite(n)) {
            expiresAtMs = n > 1e12 ? n : n * 1000;
        }
    } else if (payload.expires_in !== undefined && payload.expires_in !== null) {
        const seconds = Number(payload.expires_in);
        if (Number.isFinite(seconds)) {
            expiresAtMs = nowMs + (seconds * 1000);
        }
    } else if (token) {
        expiresAtMs = decodeJwtExpMs(token) || 0;
    }

    return { token, tokenType, expiresAtMs };
}

function hasUsableIbmIamToken() {
    if (!ibmIamTokenCache.token) return false;
    const safetyWindowMs = 30 * 1000;
    if (!ibmIamTokenCache.expiresAtMs) return true;
    return Date.now() + safetyWindowMs < ibmIamTokenCache.expiresAtMs;
}

async function fetchIbmIamTokenFromApi(apikey) {
    const response = await fetch(IBM_IAM_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ apikey }),
    });

    const responseText = await response.text();
    let payload;
    try {
        payload = JSON.parse(responseText);
    } catch {
        payload = { raw: responseText };
    }

    if (!response.ok) {
        const error = new Error('IBM IAM token request failed.');
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

async function getIbmIamToken({ apikey, forceRefresh = false } = {}) {
    const key = apikey || IBM_IAM_API_KEY;
    if (!key) {
        const error = new Error('apikey is required in request body or IBM_IAM_API_KEY env var.');
        error.status = 400;
        throw error;
    }

    if (!forceRefresh && hasUsableIbmIamToken()) {
        return {
            access_token: ibmIamTokenCache.token,
            token_type: ibmIamTokenCache.tokenType,
            expiration: ibmIamTokenCache.expiresAtMs ? Math.floor(ibmIamTokenCache.expiresAtMs / 1000) : null,
            cached: true,
        };
    }

    const payload = await fetchIbmIamTokenFromApi(key);
    const normalized = normalizeIbmIamTokenPayload(payload);
    if (!normalized.token) {
        const error = new Error('IBM IAM response did not include a token field.');
        error.status = 502;
        error.payload = payload;
        throw error;
    }

    ibmIamTokenCache.token = normalized.token;
    ibmIamTokenCache.tokenType = normalized.tokenType || 'Bearer';
    ibmIamTokenCache.expiresAtMs = normalized.expiresAtMs || 0;
    ibmIamTokenCache.fetchedAtMs = Date.now();

    return {
        ...payload,
        cached: false,
        expiration: payload.expiration ?? (normalized.expiresAtMs ? Math.floor(normalized.expiresAtMs / 1000) : null),
    };
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.get('/admindashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'admindashboard.html'));
});

function top3FromRanked(rankedClients) {
    return rankedClients
        .filter((c) => c.rank <= 3)
        .map((c) => ({
            id: c.id,
            name: c.name,
            rank: c.rank,
            score: c.priorityScore,
            calculatedRisk: c['calculated-risk'],
            confidence: c.confidence,
            primaryDriver: c.drivers?.[0] || null,
        }));
}

function ensureRankedPortfolio() {
    if (!portfolioEngine.lastRanked.length) {
        portfolioEngine.recomputePortfolio(portfolioEngine.clients);
    }
    return portfolioEngine.lastRanked;
}

app.get('/test', (req, res) => {
    res.json({ message: 'Test endpoint working!' });
});

app.post('/api/ibm/apikey-token', async (req, res) => {
    try {
        const tokenPayload = await getIbmIamToken({
            apikey: req.body?.apikey,
            forceRefresh: Boolean(req.body?.forceRefresh),
        });

        res.json(tokenPayload);
    } catch (error) {
        const status = Number(error.status) || 502;
        res.status(status).json({
            error: error.message || 'Failed to get IBM IAM token.',
            details: error.payload || error.message,
        });
    }
});

app.get('/api/ibm/apikey-token/status', (req, res) => {
    const hasToken = Boolean(ibmIamTokenCache.token);
    res.json({
        hasToken,
        tokenType: ibmIamTokenCache.tokenType,
        fetchedAt: ibmIamTokenCache.fetchedAtMs ? new Date(ibmIamTokenCache.fetchedAtMs).toISOString() : null,
        expiresAt: ibmIamTokenCache.expiresAtMs ? new Date(ibmIamTokenCache.expiresAtMs).toISOString() : null,
        expired: ibmIamTokenCache.expiresAtMs ? Date.now() >= ibmIamTokenCache.expiresAtMs : null,
        cachedTokenPreview: hasToken ? `${ibmIamTokenCache.token.slice(0, 16)}...` : null,
    });
});

app.post('/api/ibm/apikey-token/clear', (req, res) => {
    ibmIamTokenCache.token = null;
    ibmIamTokenCache.tokenType = 'Bearer';
    ibmIamTokenCache.expiresAtMs = 0;
    ibmIamTokenCache.fetchedAtMs = 0;

    res.json({ message: 'IBM IAM token cache cleared.' });
});

// Core RM-facing
app.get('/api/summary', (req, res) => {
    const ranked = ensureRankedPortfolio();
    const snapshot = portfolioEngine.computeSnapshot(ranked, ranked);
    res.json({
        snapshot,
        top3: top3FromRanked(ranked),
    });
});

app.get('/api/clients', (req, res) => {
    const ranked = ensureRankedPortfolio();
    const list = ranked.map((c) => ({
        id: c.id,
        name: c.name,
        rank: c.rank,
        score: c.priorityScore,
        calculatedRisk: c['calculated-risk'],
        confidence: c.confidence,
        primaryDriver: c.drivers?.[0] || null,
    }));

    res.json({ clients: list });
});

app.get('/api/clients/:id', (req, res) => {
    const ranked = ensureRankedPortfolio();
    const client = ranked.find((c) => c.id === req.params.id);
    if (!client) {
        res.status(404).json({ error: 'Client not found' });
        return;
    }

    res.json({
        id: client.id,
        name: client.name,
        rank: client.rank,
        priorityScore: client.priorityScore,
        calculatedRisk: client['calculated-risk'],
        rawSignals: {
            'calculated-risk': client['calculated-risk'],
            deposit_30d_pct: client.deposit_30d_pct,
            util_pct: client.util_pct,
            inflow_outflow_ratio: client.inflow_outflow_ratio,
            util_2w_delta: client.util_2w_delta,
            fx_30d_pct: client.fx_30d_pct,
            revenue_bucket: client.revenue_bucket,
            days_since_contact: client.days_since_contact,
            floating_rate: client.floating_rate,
        },
        subscores: client.subscores,
        drivers: client.drivers,
        confidence: client.confidence,
        notes: client.notes || '',
    });
});

app.get('/api/clients/:id/simulations/:simulationId', (req, res) => {
    const ranked = ensureRankedPortfolio();
    const client = ranked.find((c) => c.id === req.params.id);
    if (!client) {
        res.status(404).json({ error: 'Client not found' });
        return;
    }

    const result = portfolioEngine.runClientSimulation(client, req.params.simulationId);
    if (!result) {
        res.status(400).json({ error: 'Invalid simulationId.' });
        return;
    }

    res.json({
        clientId: client.id,
        simulationId: req.params.simulationId,
        result,
    });
});

app.get('/api/clients/:id/profile', (req, res) => {
    const client = portfolioEngine.clients.find((c) => c.id === req.params.id);
    if (!client) {
        res.status(404).json({ error: 'Client not found' });
        return;
    }

    res.json({
        id: client.id,
        calculatedRisk: portfolioEngine.calculateRisk(client),
        notes: client.notes || '',
        email: client.email || '',
    });
});

app.patch('/api/clients/:id/profile', (req, res) => {
    const client = portfolioEngine.clients.find((c) => c.id === req.params.id);
    if (!client) {
        res.status(404).json({ error: 'Client not found' });
        return;
    }

    const payload = req.body || {};
    const allowedKeys = [
        'name',
        'deposit_30d_pct',
        'util_pct',
        'inflow_outflow_ratio',
        'util_2w_delta',
        'fx_30d_pct',
        'revenue_bucket',
        'days_since_contact',
        'floating_rate',
        'notes',
        'email',
    ];

    const providedKeys = Object.keys(payload);
    if (!providedKeys.length) {
        res.status(400).json({ error: 'At least one updatable field is required.' });
        return;
    }

    const invalidKeys = providedKeys.filter((k) => !allowedKeys.includes(k));
    if (invalidKeys.length) {
        res.status(400).json({ error: `Unsupported fields: ${invalidKeys.join(', ')}` });
        return;
    }

    const next = { ...client };

    for (const key of providedKeys) {
        const value = payload[key];
        switch (key) {
        case 'name':
            if (typeof value !== 'string' || !value.trim()) {
                res.status(400).json({ error: 'name must be a non-empty string.' });
                return;
            }
            next.name = value.trim();
            break;
        case 'deposit_30d_pct':
        case 'util_2w_delta':
        case 'fx_30d_pct': {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                res.status(400).json({ error: `${key} must be a valid number.` });
                return;
            }
            next[key] = n;
            break;
        }
        case 'util_pct': {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                res.status(400).json({ error: 'util_pct must be a valid number.' });
                return;
            }
            next.util_pct = portfolioEngine.clamp(n, 0, 100);
            break;
        }
        case 'inflow_outflow_ratio': {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                res.status(400).json({ error: 'inflow_outflow_ratio must be a valid number.' });
                return;
            }
            next.inflow_outflow_ratio = portfolioEngine.clamp(n, 0, 5);
            break;
        }
        case 'days_since_contact': {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                res.status(400).json({ error: 'days_since_contact must be a valid number.' });
                return;
            }
            next.days_since_contact = Math.max(0, Math.round(n));
            break;
        }
        case 'revenue_bucket': {
            if (typeof value !== 'string') {
                res.status(400).json({ error: 'revenue_bucket must be a string.' });
                return;
            }
            const bucket = value.toUpperCase();
            if (!['LOW', 'MEDIUM', 'HIGH'].includes(bucket)) {
                res.status(400).json({ error: 'revenue_bucket must be LOW, MEDIUM, or HIGH.' });
                return;
            }
            next.revenue_bucket = bucket;
            break;
        }
        case 'floating_rate':
            if (typeof value !== 'boolean') {
                res.status(400).json({ error: 'floating_rate must be a boolean.' });
                return;
            }
            next.floating_rate = value;
            break;
        case 'notes':
        case 'email':
            if (typeof value !== 'string') {
                res.status(400).json({ error: `${key} must be a string.` });
                return;
            }
            next[key] = value;
            break;
        default:
            break;
        }
    }

    Object.assign(client, next);

    const updatedFields = providedKeys.join(', ');
    portfolioEngine.addAuditLog(client.id, `Client profile updated: ${updatedFields}`);

    portfolioEngine.recomputePortfolio(portfolioEngine.clients);
    const ranked = ensureRankedPortfolio();
    const updatedClient = ranked.find((c) => c.id === client.id);

    res.json({
        id: updatedClient.id,
        name: updatedClient.name,
        rank: updatedClient.rank,
        priorityScore: updatedClient.priorityScore,
        calculatedRisk: updatedClient['calculated-risk'],
        rawSignals: {
            deposit_30d_pct: updatedClient.deposit_30d_pct,
            util_pct: updatedClient.util_pct,
            inflow_outflow_ratio: updatedClient.inflow_outflow_ratio,
            util_2w_delta: updatedClient.util_2w_delta,
            fx_30d_pct: updatedClient.fx_30d_pct,
            revenue_bucket: updatedClient.revenue_bucket,
            days_since_contact: updatedClient.days_since_contact,
            floating_rate: updatedClient.floating_rate,
        },
        notes: updatedClient.notes || '',
        email: updatedClient.email || '',
        subscores: updatedClient.subscores,
        drivers: updatedClient.drivers,
        confidence: updatedClient.confidence,
    });
});

// Compute + scenario
app.post('/api/recompute', (req, res) => {
    const prevRanked = portfolioEngine.lastRanked.map((c) => ({ ...c }));
    const { rankedClients, snapshot } = portfolioEngine.recomputePortfolio(portfolioEngine.clients);
    const diff = portfolioEngine.diffRankings(prevRanked, rankedClients);

    res.json({
        snapshot,
        top3: top3FromRanked(rankedClients),
        diff,
    });
});

app.post('/api/scenario', (req, res) => {
    const { scenarioType, magnitude } = req.body || {};
    const allowed = ['RATE_UP_BPS', 'DEPOSIT_SHOCK_PCT'];
    if (!allowed.includes(scenarioType)) {
        res.status(400).json({ error: 'Invalid scenarioType. Use RATE_UP_BPS or DEPOSIT_SHOCK_PCT.' });
        return;
    }

    const before = ensureRankedPortfolio();
    const scenarioResult = portfolioEngine.runScenario(portfolioEngine.clients, scenarioType, magnitude);

    res.json({
        beforeTop3: top3FromRanked(before),
        afterTop3: top3FromRanked(scenarioResult.rankedClients),
        movers: scenarioResult.diff.topMovers,
        snapshot: scenarioResult.snapshot,
    });
});

// Tasks + audit
app.get('/api/tasks', (req, res) => {
    res.json({ tasks: portfolioEngine.listTasks() });
});

app.post('/api/tasks', (req, res) => {
    const { clientId, description, dueDate } = req.body || {};
    if (!clientId || !description || !dueDate) {
        res.status(400).json({ error: 'clientId, description, and dueDate are required.' });
        return;
    }

    const task = portfolioEngine.createTask({ clientId, description, dueDate });
    portfolioEngine.addAuditLog(clientId, `Task created: ${description} (due ${dueDate})`);
    res.status(201).json(task);
});

app.get('/api/audit', (req, res) => {
    const limit = Number(req.query.limit) || 20;
    const clientId = req.query.clientId;
    res.json({ audit: portfolioEngine.listAudit(limit, clientId) });
});

app.post('/api/audit/task-entry', (req, res) => {
    const { clientId, taskDescription, date } = req.body || {};
    if (!clientId || !taskDescription) {
        res.status(400).json({ error: 'clientId and taskDescription are required.' });
        return;
    }

    const timestamp = date ? new Date(date).toISOString() : new Date().toISOString();
    const taskLine = `${timestamp} - Task created: ${taskDescription}`;
    const entry = portfolioEngine.addAuditLog(clientId, taskLine);
    if (!entry) {
        res.status(400).json({ error: 'Unable to add audit entry.' });
        return;
    }

    const auditHashmap = Object.fromEntries(
        Object.entries(portfolioEngine.audit).map(([id, entries]) => [
            id,
            entries.map((item) => (typeof item === 'string' ? item : `${item.at} - ${item.auditdescription}`)),
        ])
    );

    res.status(201).json({
        message: 'Audit task entry added.',
        entry,
        audit: auditHashmap,
    });
});

// Event simulation
app.post('/api/events/input-changed', (req, res) => {
    const { clientId, eventType, magnitude } = req.body || {};
    const client = portfolioEngine.clients.find((c) => c.id === clientId);

    if (!clientId || !eventType || magnitude === undefined || !client) {
        res.status(400).json({ error: 'Valid clientId, eventType, and magnitude are required.' });
        return;
    }

    const updates = {
        DEPOSIT_30D_PCT: () => { client.deposit_30d_pct += Number(magnitude); },
        UTIL_PCT: () => { client.util_pct = portfolioEngine.clamp(client.util_pct + Number(magnitude), 0, 100); },
        INFLOW_OUTFLOW_RATIO: () => { client.inflow_outflow_ratio = portfolioEngine.clamp(client.inflow_outflow_ratio + Number(magnitude), 0, 5); },
        UTIL_2W_DELTA: () => { client.util_2w_delta += Number(magnitude); },
        FX_30D_PCT: () => { client.fx_30d_pct += Number(magnitude); },
        DAYS_SINCE_CONTACT: () => { client.days_since_contact = Math.max(0, client.days_since_contact + Number(magnitude)); },
        RATE_UP_BPS: () => {
            const shocked = portfolioEngine.applyScenarioToClient(client, 'RATE_UP_BPS', Number(magnitude));
            Object.assign(client, shocked);
        },
        DEPOSIT_SHOCK_PCT: () => {
            const shocked = portfolioEngine.applyScenarioToClient(client, 'DEPOSIT_SHOCK_PCT', Number(magnitude));
            Object.assign(client, shocked);
        },
    };

    if (!updates[eventType]) {
        res.status(400).json({ error: 'Unsupported eventType.' });
        return;
    }

    updates[eventType]();
    portfolioEngine.addAuditLog(clientId, `Input changed via event ${eventType} with magnitude ${magnitude}`);

    const prevRanked = portfolioEngine.lastRanked.map((c) => ({ ...c }));
    const { rankedClients, snapshot } = portfolioEngine.recomputePortfolio(portfolioEngine.clients);
    const diff = portfolioEngine.diffRankings(prevRanked, rankedClients);

    res.json({
        snapshot,
        top3: top3FromRanked(rankedClients),
        diff,
    });

    // Push a non-blocking event to Watsonx Orchestrate (if configured).
    void notifyWatsonEvent({
        eventType: 'INPUT_CHANGED',
        at: new Date().toISOString(),
        clientId,
        inputEvent: {
            eventType,
            magnitude: Number(magnitude),
        },
        portfolio: {
            snapshot,
            top3: top3FromRanked(rankedClients),
            diff,
        },
    });
    void requestDraftEmailFromWatson({
        clientId,
        eventType,
        magnitude,
        clientData: {
            ...client,
            'calculated-risk': portfolioEngine.calculateRisk(client),
        },
    });
});

app.get('/api/alerts', (req, res) => {
    res.json({ alerts: portfolioEngine.alerts });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
