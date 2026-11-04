// Reads one or more test-page reports (the "Copy report" text) and prints each machine's summary with a verdict.
// Usage: node analyse-report.js report1.txt [report2.txt ...]
const fs = require('fs');

const HEALTHY_CONTROL_RT = 1.0;   // ms; macOS and healthy Windows are well under this
const AFFECTED_CONTROL_RT = 2.0;  // ms; the Surface Pro 12 shows 5 ms
const num = s => (s === undefined || s === '-' ? NaN : Number(s));
const show = v => (typeof v === 'number' && !Number.isFinite(v) ? '-' : String(v));
const p50 = (block, leg) => num((block.match(new RegExp(`^\\s*${leg}\\s+n=\\d+ .*? p50 ([\\d.]+)`, 'm')) || [])[1]);
const row = (transport, fields) => ({ transport: transport.replace(/ on interface \d+/, ''), rt: NaN, out: NaN, in: NaN, status: NaN, wait: NaN, flashS: NaN, msPerPage: NaN, closeMs: NaN, over50: NaN, ...fields });

function parse(text) {
    const r = { version: (text.match(/page version ([\w.]+)/) || [])[1] || '?', notes: (text.match(/^(?:Tester notes|Computer): (.*)$/m) || [])[1] || '' };
    r.browser = (text.match(/^Browser (.*)$/m) || [])[1] || '?';
    r.platform = (text.match(/^Platform (.*)$/m) || [])[1] || '?';
    // The summary's Board line has the USB serial; the device block's lacks it after a WebHID connection.
    r.board = (text.match(/^ {3}Board: (.*)$/m) || text.match(/^Board: (.*)$/m) || [])[1] || '?';
    r.gpu = (text.match(/^GPU (.*)$/m) || [])[1] || '';
    r.connection = (text.match(/^Connection: (.*)$/m) || [])[1] || '';
    r.rows = [];
    for (const m of text.matchAll(/^\s*transport (.+?) \| round trip ([\d.-]+) \| OUT ([\d.-]+) \| IN ([\d.-]+) \| GET_STATUS ([\d.-]+) \| wait overhead ([\d.-]+) \| flash s ([\d.-]+) \| ms\/page ([\d.-]+) \| CLOSE ms ([\d.-]+) \| >50 ms ([\d-]+)/gm)) {
        r.rows.push({ transport: m[1].replace(/ on interface \d+/, ''), rt: num(m[2]), out: num(m[3]), in: num(m[4]), status: num(m[5]), wait: num(m[6]), flashS: num(m[7]), msPerPage: num(m[8]), closeMs: num(m[9]), over50: num(m[10]) });
    }
    // Older reports (before the summary table shortened its headings).
    for (const m of text.matchAll(/^\s*transport (.+?) \| RT p50 ([\d.]+) \| OUT p50 ([\d.]+) \| IN p50 ([\d.]+) \| GET_STATUS p50 ([\d.-]+) \| wait overhead at 10 ms ([\d.-]+) \| flash s ([\d.-]+) \| ms per page ([\d.-]+) \| CLOSE ms ([\d.-]+) \| flash transfers over 50 ms ([\d-]+)/gm)) {
        r.rows.push({ transport: m[1].replace(/ on interface \d+/, ''), rt: num(m[2]), out: num(m[3]), in: num(m[4]), status: num(m[5]), wait: num(m[6]), flashS: num(m[7]), msPerPage: num(m[8]), closeMs: num(m[9]), over50: num(m[10]) });
    }
    // A report copied mid-run has no summary yet: use the finished blocks, then the unfinished step.
    const blocks = text.split(/\n\s*\n/).map(b => b.trim());
    const live = blocks.find(b => b.startsWith('== In progress | '));
    if (live) {
        const [head, step] = live.split('\n');
        r.inProgress = { transport: head.split(' | ')[1], step: (step || '').trim(), out: p50(live, 'OUT'), in: p50(live, 'IN') };
    }
    if (!r.rows.length) {
        for (const block of blocks) {
            const m = block.match(/^== Round trip: DAP_Info \| (.+?) \|/);
            if (!m) continue;
            const status = blocks.find(b => b.startsWith(`== Control IN: GET_STATUS device | ${m[1]} |`));
            r.rows.push(row(m[1], { rt: p50(block, 'RT'), out: p50(block, 'OUT'), in: p50(block, 'IN'), status: status ? p50(status, 'IN') : NaN }));
        }
        const p = r.inProgress;
        if (!r.rows.length && p && Number.isFinite(p.out) && Number.isFinite(p.in)) r.rows.push(row(p.transport, { rt: p.out + p.in, out: p.out, in: p.in }));
    }
    // Only the plain probes count: the delay sweep's 50 ms step and the flash's sector writes are over 50 ms by design.
    r.over50Micro = text.split('\n\n').filter(block => /^== (Round trip|OUT only|IN only|Control IN)/.test(block) && /over 50 ms: [1-9]/.test(block)).length;
    return r;
}

function verdict(r) {
    const control = r.rows.find(x => /control transfers/.test(x.transport));
    const bulk = r.rows.find(x => /bulk/.test(x.transport));
    const hid = r.rows.find(x => /WebHID/.test(x.transport));
    const lines = [];
    const p = r.inProgress;
    if (p) lines.push(`PARTIAL: copied mid-run, during "${p.step}" on ${p.transport} (OUT p50 ${show(p.out)}, IN p50 ${show(p.in)} so far).`);
    if (r.over50Micro) lines.push(`STALLS: ${r.over50Micro} micro-benchmark blocks have transfers over 50 ms; check the browser has the Chromium fix (158.0.8114.0 or later).`);
    if (hid && hid.rt > 3) lines.push(`WebHID round trip ${hid.rt} ms is above the normal 2 ms: the whole USB path is slow on this machine (hub, power saving, other driver), not just control transfers.`);
    if (control && !Number.isFinite(control.rt) && Number.isFinite(control.in)) {
        control.rt = control.in * 2;
        lines.push(`No control OUT probe in this report; control round trip estimated as twice the IN median (${control.in} ms).`);
    }
    if (control) {
        if (control.rt <= HEALTHY_CONTROL_RT) lines.push(`Control transfers healthy: ${control.rt} ms per round trip.`);
        else if (control.rt >= AFFECTED_CONTROL_RT) lines.push(`AFFECTED: control transfers ${control.rt} ms per round trip (OUT ${show(control.out)}, IN ${show(control.in)}, GET_STATUS ${show(control.status)}); same pattern as the Surface Pro 12.`);
        else lines.push(`Borderline control transfers: ${control.rt} ms per round trip.`);
    } else lines.push('No control-transfer run in this report.');
    if (bulk) lines.push(`Bulk: ${bulk.rt} ms per round trip${Number.isFinite(bulk.flashS) ? `, flash ${bulk.flashS} s` : ''} (healthy is 0.2 to 0.5 ms).`);
    if (hid) lines.push(`WebHID: ${hid.rt} ms per round trip${Number.isFinite(hid.flashS) ? `, flash ${hid.flashS} s` : ''} (normal is 2 ms).`);
    return lines;
}

for (const file of process.argv.slice(2)) {
    const r = parse(fs.readFileSync(file, 'utf8'));
    console.log(`\n${file}`);
    console.log(`  page ${r.version} | ${r.browser} | ${r.platform}`);
    console.log(`  ${r.board}`);
    if (r.gpu) console.log(`  ${r.gpu}`);
    if (r.connection) console.log(`  connection: ${r.connection}`);
    if (r.notes) console.log(`  tester notes: ${r.notes}`);
    for (const x of r.rows) console.log(`  ${x.transport.padEnd(32)} rt ${show(x.rt).padStart(5)} out ${show(x.out).padStart(5)} in ${show(x.in).padStart(5)} getstatus ${show(x.status).padStart(5)} wait ${show(x.wait).padStart(5)} flash ${Number.isFinite(x.flashS) ? x.flashS + ' s' : '-'}`);
    for (const line of verdict(r)) console.log(`  -> ${line}`);
}
if (process.argv.length < 3) console.log('Usage: node analyse-report.js report.txt [more reports]');
