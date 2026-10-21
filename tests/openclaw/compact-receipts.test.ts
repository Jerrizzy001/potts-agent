import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {compactReceipts} from '../../scripts/openclaw/compact-approval-receipts.ts';
test('compact receipt rendering preserves canonical decision, leaves approval code untouched, and refuses unknown versions',()=>{
 const source = 'const approvalGuard = "unchanged";\nfunction buildTelegramNativeResolvedApprovalText(view) { return "original"; }\nfunction buildTelegramNativeExpiredApprovalText(view) { return "original"; }\nfunction buildTelegramCanonicalApprovalTerminalText(params) { return "original"; }';
 const changed=compactReceipts(source);
 assert.equal(compactReceipts(changed),changed);
 assert.ok(changed.includes('const approvalGuard = "unchanged";'));
 const f=runInNewContext(changed+'\n({native:buildTelegramNativeResolvedApprovalText,canonical:buildTelegramCanonicalApprovalTerminalText})');
 assert.equal(f.native({approvalKind:'exec',decision:'allow-once'}),'Approved.');
 assert.equal(f.native({approvalKind:'exec',decision:'deny'}),'Not approved.');
 assert.equal(f.native({approvalKind:'plugin',decision:'deny'}),'original');
 assert.equal(f.canonical({result:{applied:false,approval:{presentation:{kind:'exec'},status:'denied',decision:'deny'}}}),'Not approved.');
 assert.throws(()=>compactReceipts('different version'),/Unrecognized/);
});
