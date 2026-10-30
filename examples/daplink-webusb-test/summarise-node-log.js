// Summarises the per-transfer timings that usb.js and hid.js print, and copies the summary to the clipboard on Windows.
const fs = require('fs');
const { execSync } = require('child_process');

// PowerShell redirection writes UTF-16 with a byte order mark.
const raw = fs.readFileSync(process.argv[2] || 'usb-run.txt');
const text = raw[0] === 0xFF && raw[1] === 0xFE ? raw.toString('utf16le') : raw.toString('utf8');

function stats(label, re) {
    const a = [];
    let m;
    while ((m = re.exec(text))) a.push(+m[1]);
    if (!a.length) return `${label}: none`;
    a.sort((x, y) => x - y);
    const p = q => a[Math.min(a.length - 1, Math.round((a.length - 1) * q))].toFixed(2);
    const sum = a.reduce((s, v) => s + v, 0);
    const over50 = a.filter(v => v > 50).length;
    return `${label}: n=${a.length} min ${a[0].toFixed(2)} p50 ${p(0.5)} p90 ${p(0.9)} p99 ${p(0.99)} max ${a[a.length - 1].toFixed(2)} mean ${(sum / a.length).toFixed(2)} ms, sum ${(sum / 1000).toFixed(1)} s, over 50 ms: ${over50}`;
}

const lines = [
    `node ${process.version} ${process.platform} ${process.arch}`,
    stats('controlOUT', /controlTransferOut\(\d+B\) ([\d.]+)ms/g),
    stats('controlIN', /controlTransferIn\(\d+B\) ([\d.]+)ms/g),
    stats('bulkOUT', /endpointOut\.transfer\(\d+B\) ([\d.]+)ms/g),
    stats('bulkIN', /endpointIn\.transfer\(\d+B\) ([\d.]+)ms/g),
    stats('hidWrite', /\[HID\] write\(\) \d+B ([\d.]+)ms/g),
    stats('hidRead', /\[HID\] read\(\) \d+B ([\d.]+)ms/g),
    ...(text.match(/\[DAPdbg\] Flash (complete|error)[^\n]*/g) || []),
    ...(text.match(/\[USB\] (Opened|Interface|Endpoint)[^\n]*/g) || [])
];
const out = lines.join('\n');
console.log(out);
if (process.platform === 'win32') {
    try { execSync('clip', { input: out }); console.log('(copied to clipboard)'); } catch (e) { console.log('clip failed: ' + e.message); }
}
