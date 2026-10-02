const CLAIM_PASS_AT = 0.9;
const CLAIM_FAIL_AT = 0.1;
const PICK_ACCEPT_AT = 0.5;
/** Several claims at once: fail beats inconclusive beats pass, so one broken claim fails them all. */
export function decideAll(probabilities) {
    const decisions = probabilities.map((p) => decide(p, 'expect'));
    return decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
}
export function decide(probability, kind) {
    if (kind === 'pick')
        return probability >= PICK_ACCEPT_AT ? 'pass' : 'inconclusive';
    if (probability >= CLAIM_PASS_AT)
        return 'pass';
    return probability <= CLAIM_FAIL_AT ? 'fail' : 'inconclusive';
}
