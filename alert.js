#!/usr/bin/env node
// Demand Wizard — daily qualification reminder with thread follow-ups
//
// Each run (5 PM IST):
//   1. Checks previous days' pending leads → replies in their original thread
//   2. Posts a new alert for the last 24 hours → saves ts to state.json

const fs   = require('fs');
const path = require('path');

const HUBSPOT_TOKEN     = process.env.HUBSPOT_TOKEN;
const SLACK_TOKEN       = process.env.SLACK_TOKEN;
const SLACK_CHANNEL     = 'C0ATT4Y2CMQ';
const PORTAL_ID         = '45469632';
const CONTACT_URL       = `https://app.hubspot.com/contacts/${PORTAL_ID}/contact`;
const STATE_FILE        = path.join(__dirname, 'state.json');
const MAX_FOLLOWUP_DAYS = 7;   // stop reminding after this many days
const MAX_LEADS_SHOWN   = 15;  // max leads listed per owner block (Slack 3000-char limit)

if (!HUBSPOT_TOKEN || !SLACK_TOKEN) {
  console.error('Missing env vars: HUBSPOT_TOKEN and SLACK_TOKEN are required');
  process.exit(1);
}

// ── State ──────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Time helpers ───────────────────────────────────────────────────────────

function getWindow() {
  // Allow manual backfills: WINDOW_START_MS / WINDOW_END_MS override the default 24h rolling window
  const windowEnd   = process.env.WINDOW_END_MS   ? Number(process.env.WINDOW_END_MS)   : Date.now();
  const windowStart = process.env.WINDOW_START_MS ? Number(process.env.WINDOW_START_MS) : windowEnd - 24 * 60 * 60 * 1000;
  const IST         = new Date(windowEnd + 5.5 * 60 * 60 * 1000);
  const y = IST.getUTCFullYear();
  const m = String(IST.getUTCMonth() + 1).padStart(2, '0');
  const d = String(IST.getUTCDate()).padStart(2, '0');
  return { windowStart, windowEnd, label: `${d}/${m}/${y}`, key: `${y}-${m}-${d}` };
}

// ── HubSpot ────────────────────────────────────────────────────────────────

function isTenantLead(customerType) {
  if (!customerType) return false;
  const vals = customerType.split(';').map(v => v.trim());
  return vals.includes('Tenant Lead') || vals.includes('Tenant');
}

async function searchContacts(windowStart, windowEnd, after = null) {
  const body = {
    filterGroups: [{
      filters: [
        { propertyName: 'createdate', operator: 'GTE', value: String(windowStart) },
        { propertyName: 'createdate', operator: 'LTE', value: String(windowEnd)   },
      ],
    }],
    properties: ['firstname', 'lastname', 'hubspot_owner_id', 'customer_type', 'hs_lead_status'],
    limit: 100,
    ...(after ? { after } : {}),
  };
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HubSpot search error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function batchReadContacts(ids) {
  // HubSpot batch limit is 100 — chunk if needed
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const results = [];
  for (const chunk of chunks) {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/read', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: chunk.map(id => ({ id })),
        properties: ['firstname', 'lastname', 'hubspot_owner_id', 'hs_lead_status'],
      }),
    });
    if (!res.ok) throw new Error(`HubSpot batch error: ${res.status}`);
    const data = await res.json();
    results.push(...data.results);
  }
  return results;
}

async function fetchOwners() {
  const res = await fetch('https://api.hubapi.com/crm/v3/owners?limit=100', {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!res.ok) return {};
  const data = await res.json();
  return Object.fromEntries(
    data.results.map(o => [String(o.id), [o.firstName, o.lastName].filter(Boolean).join(' ')])
  );
}

// ── Slack ──────────────────────────────────────────────────────────────────

async function postMessage({ text, blocks, threadTs = null }) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text,
      ...(blocks ? { blocks } : {}),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data.ts;
}

// ── Block builders ─────────────────────────────────────────────────────────

function groupByOwner(contacts, owners) {
  const map = {};
  for (const c of contacts) {
    const ownerId = c.properties.hubspot_owner_id;
    const name    = ownerId ? (owners[ownerId] ?? `Owner ${ownerId}`) : 'Unassigned';
    if (!map[name]) map[name] = [];
    const display = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' ') || 'Unnamed';
    map[name].push({ display, id: c.id });
  }
  return map;
}

function pendingLeadBlocks(byOwner) {
  return Object.entries(byOwner).map(([owner, leads]) => {
    const shown = leads.slice(0, MAX_LEADS_SHOWN);
    const extra = leads.length - shown.length;
    const lines = shown.map(l => `• <${CONTACT_URL}/${l.id}|${l.display}>`);
    if (extra > 0) lines.push(`_…and ${extra} more — check HubSpot_`);
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${owner}* — ${leads.length} pending\n${lines.join('\n')}`,
      },
    };
  });
}

function buildAlertBlocks({ label, total, marked, pending, byOwner }) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔔 Qualification Pending — ${label}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${total} tenant leads in the last 24 hrs* — ${marked} marked ✅  |  *${pending} still unknown* 🔴\nPlease mark each lead as *Qualified* or *Disqualified* in HubSpot.`,
      },
    },
    { type: 'divider' },
    ...pendingLeadBlocks(byOwner),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Update *Lead Status* on each contact: Qualified | Disqualified | Future Prospect' }],
    },
  ];
}

function buildReminderBlocks({ origLabel, totalWas, stillPending, byOwner }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔁 *Reminder* — ${stillPending} of the original ${totalWas} leads from *${origLabel}* are still unmarked.`,
      },
    },
    { type: 'divider' },
    ...pendingLeadBlocks(byOwner),
  ];
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const state = loadState();
  const { windowStart, windowEnd, label, key } = getWindow();
  const owners = await fetchOwners();

  // 1. Follow up on previous days still in state
  for (const [dateKey, entry] of Object.entries(state)) {
    if (dateKey === key) continue;

    const ageDays = (Date.now() - new Date(dateKey + 'T00:00:00Z').getTime()) / 86400000;
    if (ageDays > MAX_FOLLOWUP_DAYS) {
      console.log(`  → Dropping ${entry.label} (older than ${MAX_FOLLOWUP_DAYS} days)`);
      delete state[dateKey];
      continue;
    }

    console.log(`Checking previous pending leads from ${entry.label}…`);
    const contacts     = await batchReadContacts(entry.pendingIds);
    const stillPending = contacts.filter(c => !c.properties.hs_lead_status);

    if (stillPending.length === 0) {
      await postMessage({
        text: `✅ All leads from ${entry.label} have now been marked. Well done!`,
        threadTs: entry.ts,
      });
      delete state[dateKey];
      console.log(`  → All resolved for ${entry.label}`);
    } else {
      const byOwner = groupByOwner(stillPending, owners);
      await postMessage({
        text: `🔁 ${stillPending.length} leads from ${entry.label} still pending`,
        blocks: buildReminderBlocks({
          origLabel:    entry.label,
          totalWas:     entry.pendingIds.length,
          stillPending: stillPending.length,
          byOwner,
        }),
        threadTs: entry.ts,
      });
      state[dateKey].pendingIds = stillPending.map(c => c.id);
      console.log(`  → ${stillPending.length} still pending for ${entry.label}, reminder sent in thread`);
    }
  }

  // 2. Fetch leads for the current 24-hour window
  const allContacts = [];
  let after = null;
  do {
    const page = await searchContacts(windowStart, windowEnd, after);
    allContacts.push(...page.results);
    after = page.paging?.next?.after ?? null;
  } while (after);

  const tenantLeads = allContacts.filter(c => isTenantLead(c.properties.customer_type));
  const pending     = tenantLeads.filter(c => !c.properties.hs_lead_status);
  const marked      = tenantLeads.length - pending.length;

  console.log(`${label}: ${tenantLeads.length} tenant leads — ${marked} marked, ${pending.length} pending`);

  if (tenantLeads.length === 0) {
    console.log('No tenant leads in last 24h — skipping new alert');
    saveState(state);
    return;
  }

  // 3. Post today's alert
  let ts;
  if (pending.length === 0) {
    ts = await postMessage({
      text: `✅ All ${tenantLeads.length} tenant leads from ${label} are marked. Great work!`,
    });
  } else {
    const byOwner = groupByOwner(pending, owners);
    ts = await postMessage({
      text: `${pending.length} of ${tenantLeads.length} tenant leads pending qualification — ${label}`,
      blocks: buildAlertBlocks({ label, total: tenantLeads.length, marked, pending: pending.length, byOwner }),
    });

    // Save to state so tomorrow's run can follow up in this thread
    state[key] = {
      ts,
      label,
      pendingIds: pending.map(c => c.id),
    };
  }

  saveState(state);
  console.log(`Done. ts=${ts}`);
}

main().catch(err => { console.error(err); process.exit(1); });
