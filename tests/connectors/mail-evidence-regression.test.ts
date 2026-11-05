import {repairMailEvidence} from '../../src/daemon/repair-mail-evidence.ts';
import {createTestHarness} from '../../src/broker/testing.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrate} from '../../src/store/migrate.ts';
import {withTransaction} from '../../src/store/db.ts';
import {createFakeClock} from '../../src/core/clock.ts';
import {classifyMail,detectInterview} from '../../src/connectors/mail/classify.ts';
import {refineWithModel} from '../../src/connectors/mail/local-model.ts';
import {createMailStore} from '../../src/connectors/mail/store.ts';
import {normalizeGmailMessage} from '../../src/connectors/gmail/reader.ts';
import {createUrgentEventStore} from '../../src/notifications/urgent.ts';
import {createOutbox} from '../../src/notifications/outbox.ts';
import {bindUrgentEventsToOutbox} from '../../src/notifications/bind.ts';
import {createBriefingComposer} from '../../src/notifications/briefings.ts';
import {quietHoursFromConfig} from '../../src/notifications/quiet-hours.ts';
import {mailEventInvalidReason} from '../../src/daemon/mail-evidence.ts';
import {createUrgentIncidentValidator} from '../../src/daemon/alerts.ts';
import {mailPrioritySource} from '../../src/daemon/sources.ts';

const receipt='We received your job application. If your profile aligns with our requirements, Recruiting will be in touch. We never charge fees for an interview or technical assessment. Application status: https://company.myworkdayjobs.com/careers';
const mail=(body=receipt,subject='Your recent job application')=>normalizeGmailMessage('test',{id:'receipt',payload:{headers:[{name:'From',value:'no-reply@company.example'},{name:'Subject',value:subject}],mimeType:'text/plain',body:{data:Buffer.from(body).toString('base64url')}}});

test('receipts, conditional interview language, careers links and model guesses are not invitations',async()=>{
 for(const body of [receipt,'Thank you for applying. If selected, we will invite you to an interview. Next steps: https://company.greenhouse.io/roles','Interview tips: please schedule a mock interview.'])assert.equal(detectInterview(mail(body),false).detected,false);
 assert.equal(detectInterview(mail('Interview details https://calendly.com.evil.example/schedule','Your interview'),false).detected,false);
 assert.equal(detectInterview(mail('We would like to invite you to an interview. Please share your availability.'),false).detected,true);
 assert.equal(detectInterview(mail('Thank you for applying. We would like to invite you to an interview. Please select a time.'),false).detected,true);
 const m=mail(),h=classifyMail(m);assert.notEqual(h.category,'interview_invitation');
 const guessed=await refineWithModel(m,{...h,category:'personal'}, {enabled:true,classify:async()=>({category:'interview_invitation',confidence:1})});assert.notEqual(guessed.category,'interview_invitation');
});

test('same-content correction persists; old urgent events vanish from briefing, notification and call paths',async()=>{
 const db=new DatabaseSync(':memory:'),clock=createFakeClock('2026-10-22T01:00:00Z');migrate(db,{clock});try{
  const store=createMailStore(db,clock),m=mail(),actual=classifyMail(m),wrong={...actual,category:'interview_invitation' as const,priority:'priority' as const};store.upsert(m,wrong);
  assert.equal(store.upsert(m,actual),'updated');assert.equal(store.upsert(m,actual),'unchanged');assert.notEqual(store.get('test','receipt')!.category,'interview_invitation');
  // Seed a legacy alert before attaching current-source validation.
  const legacy=createUrgentEventStore(db,clock);const ev=legacy.raise({dedupKey:'mail:test:receipt',sourceType:'interview_invitation',sourceRef:'test:receipt',title:'Interview invitation from Example',detail:{accountId:'test',messageId:'receipt'},shouldCall:true}).event;
  const urgent=createUrgentEventStore(db,clock,e=>mailEventInvalidReason(store,e));let sends=0;
  const outbox=createOutbox({db,clock,quiet:quietHoursFromConfig({owner:{timezone:'America/Toronto'},quietHours:{start:'23:00',end:'08:00'}}),channel:{name:'fake',send:async()=>{sends++;return {providerMessageId:'fake'};}}});bindUrgentEventsToOutbox(urgent,outbox);
  outbox.enqueue({dedupKey:'old-alert',category:'urgent',eventRef:ev.id,text:ev.title});
  const composer=createBriefingComposer({db,clock,timezone:'America/Toronto',providers:{},outbox,urgent});
  assert.doesNotMatch((await composer.compose('night','today')).text,/Interview invitation/);
  assert.equal(createUrgentIncidentValidator(urgent).revalidate(ev.id).active,false);
  await outbox.dispatchDue();assert.equal(sends,0);assert.equal(urgent.get(ev.id)!.status,'resolved');
  store.upsert(m,wrong);assert.deepEqual(await mailPrioritySource(store).listPriorityItems('2020-01-01T00:00:00Z'),[],'stale category cannot enter relevant messages either');
 }finally{db.close();}
});

test('source validation preserves qualifying partnerships and retires bulk or missing source mail',()=>{
 const db=new DatabaseSync(':memory:'),clock=createFakeClock('2026-10-22T01:00:00Z');migrate(db,{clock});try{
  const store=createMailStore(db,clock),m={...mail('Our company would love to partner with you on a joint venture.','Partnership'),from:{address:'partner@company.example',name:'Example Partner'}};
  store.upsert(m);assert.equal(store.get('test','receipt')!.category,'company_partnership');
  const urgent=createUrgentEventStore(db,clock,e=>mailEventInvalidReason(store,e));
  const ev=urgent.raise({dedupKey:'partnership',sourceType:'business_enquiry',sourceRef:'test:receipt',title:'Partnership enquiry',detail:{accountId:'test',messageId:'receipt'},shouldCall:true}).event;
  assert.equal(ev.status,'open');assert.equal(urgent.listOpen().length,1);
  const actual=classifyMail(m);store.upsert(m,{...actual,bulk:true});
  assert.deepEqual(urgent.listOpen(),[]);assert.equal(urgent.get(ev.id)!.status,'resolved');
  const missing=urgent.raise({dedupKey:'missing',sourceType:'business_enquiry',sourceRef:'test:absent',title:'Missing enquiry',detail:{accountId:'test',messageId:'absent'},shouldCall:true}).event;
  assert.equal(missing.status,'resolved');
 }finally{db.close();}
});

test('a briefing queued before a correction is dropped and its routine updates preserved',async()=>{
 const db=new DatabaseSync(':memory:'),clock=createFakeClock('2026-10-22T01:00:00Z');migrate(db,{clock});try{
  const store=createMailStore(db,clock),m=mail('We invite you to an interview. Please share your availability.');store.upsert(m);
  const urgent=createUrgentEventStore(db,clock,e=>mailEventInvalidReason(store,e));urgent.raise({dedupKey:'invitation',sourceType:'interview_invitation',sourceRef:'test:receipt',title:'Interview invitation',detail:{accountId:'test',messageId:'receipt'},shouldCall:false});
  let sends=0;const outbox=createOutbox({db,clock,quiet:quietHoursFromConfig({owner:{timezone:'America/Toronto'},quietHours:{start:'23:00',end:'08:00'}}),channel:{name:'fake',send:async()=>{sends++;return {providerMessageId:'fake'};}}});outbox.enqueue({dedupKey:'routine',category:'routine',text:'Keep this update'});
  const composer=createBriefingComposer({db,clock,timezone:'America/Toronto',providers:{},outbox,urgent});const queued=await composer.deliver('night','night','today');assert.match(queued.draft!.text,/Interview invitation/);
  store.upsert(m,{...classifyMail(m),category:'job_opportunity'});
  await outbox.dispatchDue();assert.equal(sends,0);assert.equal(outbox.getByDedupKey('routine')!.status,'pending');
  assert.doesNotMatch((await composer.compose('night','next')).text,/Interview invitation/);
 }finally{db.close();}
});


test('offline repair is dry-run first, cancels only obsolete pending effects, and is idempotent',()=>{
 const h=createTestHarness();try{
  const store=createMailStore(h.db,h.clock),m=mail(),actual=classifyMail(m);store.upsert(m,{...actual,category:'interview_invitation',priority:'priority'});
  const urgent=createUrgentEventStore(h.db,h.clock),ev=urgent.raise({dedupKey:'old',sourceType:'interview_invitation',sourceRef:'test:receipt',title:'Incorrect invitation',detail:{accountId:'test',messageId:'receipt'},shouldCall:true}).event;
  const proposal=h.broker.propose({kind:'call_owner_alert',accountId:'telephony-alerts',destination:['owner'],payload:{incidentId:ev.id,trigger:'interview_invitation',attempt:1}},'test');assert.ok(proposal.ok);
  h.db.prepare("INSERT INTO owner_alert_incidents(id,trigger_kind,status,next_attempt_at,pending_action_id,created_at,updated_at) VALUES(?,'interview_invitation','active',?,?,?,?)").run(ev.id,h.clock.nowIso(),proposal.value.actionId,h.clock.nowIso(),h.clock.nowIso());
  const approval=withTransaction(h.db,()=>h.broker.approvals.request(h.broker.getAction(proposal.value.actionId)!,h.broker.currentPolicy()));
  const dry=repairMailEvidence(h.db,h.clock);assert.equal(dry.approvalsExpired,1);assert.equal(dry.mailCorrections,1);assert.equal(dry.alertsResolved,1);assert.equal(urgent.get(ev.id)!.status,'open');
  const applied=repairMailEvidence(h.db,h.clock,true);assert.equal(applied.approvalsExpired,dry.approvalsExpired);assert.equal(h.broker.approvals.get(approval.id)!.status,'cancelled');assert.equal(applied.alertsResolved,1);assert.equal(applied.incidentsResolved,1);assert.equal(applied.actionsCancelled,1);assert.equal(h.broker.getAction(proposal.value.actionId)!.status,'cancelled');assert.equal(h.provider.accepted.length,0);
  assert.equal(repairMailEvidence(h.db,h.clock).mailCorrections,0);assert.equal(repairMailEvidence(h.db,h.clock).alertsResolved,0);assert.ok(h.broker.audit.verify().ok);
 }finally{h.close();}
});
