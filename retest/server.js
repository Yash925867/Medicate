const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureUsersFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, '[]', 'utf8');
    }
}

function readUsers() {
    ensureUsersFile();

    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (error) {
        console.error('Failed to read users file:', error.message);
        return [];
    }
}

function writeUsers(users) {
    ensureUsersFile();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

app.use(express.static('public'));
app.use(express.json());

app.post('/api/signup', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name || !phone || !email || !password) {
        return res.status(400).json({ error: 'All signup fields are required.' });
    }

    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const users = readUsers();
    const exists = users.some((user) => user.email === email);

    if (exists) {
        return res.status(409).json({ error: 'Account already exists. Please login instead.' });
    }

    const user = { name, phone, email, password };
    users.push(user);
    writeUsers(users);

    return res.status(201).json({
        message: 'Account created successfully.',
        user: { name: user.name, email: user.email, phone: user.phone }
    });
});

app.post('/api/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    const users = readUsers();
    const user = users.find((entry) => entry.email === email && entry.password === password);

    if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.json({
        message: 'Login successful.',
        user: { name: user.name, email: user.email, phone: user.phone }
    });
});

app.post('/api/search', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    try {
        const rxNormResponse = await axios.get(`https://rxnav.nlm.nih.gov/REST/drugs.json?name=${query}`);
        const conceptGroup = rxNormResponse.data.drugGroup.conceptGroup;

        if (conceptGroup && conceptGroup.length > 0) {
            const mainDrug = conceptGroup.find((g) => g.tty === 'SBD' || g.tty === 'BPCK')?.conceptProperties[0]
                || conceptGroup[0]?.conceptProperties[0];

            if (mainDrug) {
                const rxcui = mainDrug.rxcui;
                const [medlineResponse, fdaResponse, ingredientsResponse] = await Promise.all([
                    axios.get(`https://connect.medlineplus.gov/service?mainSearchCriteria.v.c=${mainDrug.name}&mainSearchCriteria.v.cs=2.16.840.1.113883.6.103&knowledgeResponseType=application/json`),
                    axios.get(`https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${mainDrug.name}"&limit=1`),
                    axios.get(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=IN`)
                ]);

                const ingredientsData = ingredientsResponse.data.relatedGroup.conceptGroup?.[0]?.conceptProperties;

                return res.json({
                    type: 'Drug',
                    name: mainDrug.name,
                    summary: medlineResponse.data?.feed?.entry?.[0]?.summary?._value || 'No detailed description found.',
                    manufacturer: fdaResponse.data.results?.[0]?.openfda?.manufacturer_name?.[0] || 'Not available.',
                    ingredients: ingredientsData ? ingredientsData.map((ing) => ing.name) : ['Not available.'],
                    source: 'Official APIs'
                });
            }
        }

        const medlineXml = await axios.get(`https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=${query}&retmax=1`);
        const parsedXml = await xml2js.parseStringPromise(medlineXml.data);
        const content = parsedXml.nlmSearchResult?.list?.[0]?.document?.[0]?.content;

        if (content) {
            const summaryField = content.find((c) => c.$?.name === 'FullSummary');
            if (summaryField) {
                const summary = summaryField._.replace(/<span class="qt0">/g, '').replace(/<\/span>/g, '');
                return res.json({ type: 'Disease', name: query, summary, source: 'Official APIs' });
            }
        }

        console.log(`Official APIs failed for "${query}". Falling back to Gemini AI.`);

        const geminiApiKey = process.env.GEMINI_API_KEY;
        const geminiUrl = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
        const prompt = `You are a medical assistant. Provide a concise, easy-to-read summary for the term "${query}". If it's a medicine, list its primary uses and active ingredients. Format the output in simple HTML using <h3> and <p> tags. Do not use markdown.`;

        const geminiResponse = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }]
        });

        const text = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text;
        return res.json({ type: 'AI', name: query, summary: text, source: 'Gemini AI' });
    } catch (error) {
        if (error.response && error.response.data && error.response.data.error) {
            console.error('API Error:', JSON.stringify(error.response.data.error, null, 2));
        } else {
            console.error('Error:', error.message);
        }
        res.status(500).json({ error: 'Failed to fetch data.' });
    }
});

app.listen(PORT, () => {
    ensureUsersFile();
    console.log(`Medicate server running on http://localhost:${PORT}`);
});
