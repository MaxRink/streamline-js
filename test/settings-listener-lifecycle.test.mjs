import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');

test('settings reuses process-lifetime listener identities when reopened', () => {
    assert.match(source, /connectDisplayWebSocket\(handleDisplayState\);/);
    assert.match(source, /document\.addEventListener\('streamline:languagechange', handleSettingsLanguageChange\);/);
    assert.doesNotMatch(source, /connectDisplayWebSocket\(\(data\) =>/);
    assert.doesNotMatch(source, /document\.addEventListener\('streamline:languagechange', \(\) =>/);
});

test('cleanupSettings stops the sensor-calibration poll and tears down the maintenance mount', () => {
    const start = source.indexOf('export function cleanupSettings()');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    assert.match(body, /sensorCalStopLive\(\);/);
    assert.match(body, /maintenanceSequence \+= 1;\s*maintenanceCleanup\?\.\(\);\s*maintenanceCleanup = null;/);
});
