// The Shot details dialog: a list of rows from shot-details.js, plus rows that arrive later
// (the dial-in plugin's answer). Shares the surface dialog's frame and close behaviour.

import { getTranslation } from './i18n.js';
import { loadStyle } from './vendor-loader.js';

const styleReady = loadStyle('src/css/surface-dialog.css').catch(() => {});

function rowElements(rows) {
    return rows.flatMap(({ label, value, translate }) => {
        const term = document.createElement('dt');
        term.textContent = label ? getTranslation(label) : '';
        const detail = document.createElement('dd');
        detail.textContent = translate ? getTranslation(value) : value;
        if (!label) detail.className = 'shot-details-note';
        return [term, detail];
    });
}

export async function openShotDetails(title, rows, laterRows = null) {
    const opener = document.activeElement;
    await styleReady;
    const dialog = document.createElement('dialog');
    dialog.className = 'surface-dialog surface-dialog-compact';
    dialog.setAttribute('aria-labelledby', 'shot-details-title');
    dialog.innerHTML = `
        <div class="surface-dialog-header">
            <h2 id="shot-details-title" class="surface-dialog-title"></h2>
            <button type="button" class="surface-dialog-close"><span aria-hidden="true">×</span><span data-label></span></button>
        </div>
        <dl class="shot-details-list"></dl>`;
    dialog.querySelector('.surface-dialog-title').textContent = title;
    dialog.querySelector('[data-label]').textContent = getTranslation('Close');
    const list = dialog.querySelector('.shot-details-list');
    const paint = all => list.replaceChildren(...(all.length ? rowElements(all) : rowElements([{ label: '', value: getTranslation('No details recorded for this shot.') }])));
    paint(rows);

    const close = () => {
        if (!dialog.isConnected) return;
        if (dialog.open) dialog.close();
        dialog.remove();
        if (opener?.isConnected) opener.focus?.();
    };
    dialog.addEventListener('close', close);
    dialog.querySelector('.surface-dialog-close').addEventListener('click', close);
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('.surface-dialog-close').focus();

    laterRows?.then(extra => { if (dialog.isConnected && extra?.length) paint([...rows, ...extra]); }).catch(() => {});
    return dialog;
}
