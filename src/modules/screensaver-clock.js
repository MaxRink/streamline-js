export const SCREENSAVER_CLOCK_FORMATS = [
    { value: 'locale', label: 'Device default' },
    { value: '12', label: '12-hour' },
    { value: '24', label: '24-hour' },
];

export const SCREENSAVER_CLOCK_POSITIONS = [
    { value: 'top-left', label: 'Top left' },
    { value: 'top-center', label: 'Top center' },
    { value: 'top-right', label: 'Top right' },
    { value: 'bottom-left', label: 'Bottom left' },
    { value: 'bottom-center', label: 'Bottom center' },
    { value: 'bottom-right', label: 'Bottom right' },
];

export function resolveScreensaverClockFormat(value) {
    return SCREENSAVER_CLOCK_FORMATS.some(option => option.value === value) ? value : 'locale';
}

export function resolveScreensaverClockPosition(value) {
    return SCREENSAVER_CLOCK_POSITIONS.some(option => option.value === value) ? value : 'bottom-center';
}

export function formatScreensaverClockTime(date, format, locales = []) {
    const resolved = resolveScreensaverClockFormat(format);
    const options = { hour: '2-digit', minute: '2-digit' };
    // h23 keeps midnight at 00:00 even in locales whose 24-hour default is h24.
    if (resolved !== 'locale') options.hourCycle = resolved === '24' ? 'h23' : 'h12';
    return date.toLocaleTimeString(locales, options);
}

export function screensaverClockPositionStyle(position) {
    const [vertical, horizontal] = resolveScreensaverClockPosition(position).split('-');
    return {
        top: vertical === 'top' ? '8%' : 'auto',
        bottom: vertical === 'bottom' ? '8%' : 'auto',
        left: horizontal === 'center' ? '0px' : '5%',
        right: horizontal === 'center' ? '0px' : '5%',
        alignItems: horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center',
        textAlign: horizontal,
    };
}
