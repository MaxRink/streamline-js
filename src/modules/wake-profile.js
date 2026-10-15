// The wake profile loads when the machine wakes -- unless the user (or a plugin)
// chose a different profile while it slept, which must not be overwritten.
// DOM-free so node:test can import it.
import { profileFingerprint } from './dye-selection.js';

export const SLEEP_PROFILE_KEY = 'streamline.sleepProfile';

/** What identifies the profile in the workflow at the moment the machine goes to sleep. */
export function sleepProfileMark(workflow) {
    return profileFingerprint(workflow?.profile);
}

/**
 * Load the wake profile only when the workflow still holds the profile it had at
 * sleep. No mark (the page reloaded during sleep, or sleep was never seen) means
 * nothing to compare, so behaviour is as before: load it. An unreadable live
 * workflow also loads it, rather than silently never waking onto it.
 */
export function shouldApplyWakeProfile(mark, liveWorkflow) {
    if (!mark) return true;
    const live = profileFingerprint(liveWorkflow?.profile);
    if (!live) return true;
    return live === mark;
}
