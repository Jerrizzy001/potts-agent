import {classifyMail,detectInterview} from '../connectors/mail/classify.ts';
import {createMailStore,type StoredMail} from '../connectors/mail/store.ts';
import type {NormalizedMail} from '../connectors/mail/types.ts';
import type {Db} from '../store/db.ts';
import {withTransaction} from '../store/db.ts';
import type {Clock} from '../core/clock.ts';
import {createUrgentEventStore} from '../notifications/urgent.ts';
import {createAuditLedger} from '../audit/ledger.ts';
import {createApprovalStore} from '../approvals/store.ts';
import {mailEventInvalidReason} from './mail-evidence.ts';

const normalized=(m:StoredMail):NormalizedMail=>({accountId:m.accountId,provider:m.provider,providerMessageId:m.providerMessageId,threadId:m.threadId,internetMessageId:m.internetMessageId,from:m.from,to:m.to,cc:m.cc,replyTo:m.replyTo,subject:m.subject,snippet:m.snippet,bodyText:m.bodyText,bodySource:m.bodySource,receivedAt:m.receivedAt,labels:m.labels,headers:m.headers,attachments:m.attachments,contentFlags:m.contentFlags});

/** Offline, local-only repair. No network, account consent or provider writes. */
export function repairMailEvidence(db:Db,clock:Clock,apply=false){
 const mail=createMailStore(db,clock),urgent=createUrgentEventStore(db,clock);
 const corrections=mail.list({category:'interview_invitation',limit:-1}).filter(m=>!detectInterview(m,m.classification.bulk).detected);
 const invalid=urgent.listBySource('interview_invitation').filter(e=>e.status!=='resolved'&&mailEventInvalidReason(mail,e)!==null);
 const report={apply,mailCorrections:corrections.length,alertsResolved:invalid.length,notificationsDropped:0,actionsCancelled:0,approvalsExpired:0,incidentsResolved:0};
 if(!apply){
  const pending=new Set<string>();
  for(const event of invalid){
   for(const n of db.prepare("SELECT id FROM owner_notifications WHERE status='pending' AND (event_ref=? OR (category='briefing' AND instr(text,?)>0))").all(event.id,event.title))pending.add(String(n.id));
   report.actionsCancelled+=Number(db.prepare("SELECT count(*) n FROM actions WHERE kind='call_owner_alert' AND status IN ('held','ready','awaiting_approval') AND json_extract(payload_json,'$.incidentId')=?").get(event.id)!.n);
   report.approvalsExpired+=Number(db.prepare("SELECT count(*) n FROM approvals WHERE status IN ('pending','approved') AND action_id IN (SELECT id FROM actions WHERE kind='call_owner_alert' AND status IN ('held','ready','awaiting_approval') AND json_extract(payload_json,'$.incidentId')=?)").get(event.id)!.n);
   report.incidentsResolved+=Number(db.prepare("SELECT count(*) n FROM owner_alert_incidents WHERE id=? AND status='active'").get(event.id)!.n);
  }
  report.notificationsDropped=pending.size;
  return report;
 }
 return withTransaction(db,()=>{
  const audit=createAuditLedger(db,clock),approvals=createApprovalStore(db,audit,clock),now=clock.nowIso();
  for(const m of corrections){const source=normalized(m);mail.upsert(source,classifyMail(source));}
  for(const event of invalid){
   urgent.resolve(event.id,'Original cached email does not establish an interview invitation');
   report.incidentsResolved+=Number(db.prepare("UPDATE owner_alert_incidents SET status='resolved',status_reason='Mail evidence corrected',pending_action_id=NULL,updated_at=? WHERE id=? AND status='active'").run(now,event.id).changes);
   for(const action of db.prepare("SELECT id FROM actions WHERE kind='call_owner_alert' AND status IN ('held','ready','awaiting_approval') AND json_extract(payload_json,'$.incidentId')=?").all(event.id)){
    for(const approval of db.prepare("SELECT id FROM approvals WHERE action_id=? AND status IN ('pending','approved')").all(String(action.id)))if(approvals.close(String(approval.id),'cancelled','system:mail-evidence-repair','Source evidence corrected').ok)report.approvalsExpired++;
    report.actionsCancelled+=Number(db.prepare("UPDATE actions SET status='cancelled',updated_at=? WHERE id=?").run(now,String(action.id)).changes);
    audit.append({type:'action_cancelled',actor:'system:mail-evidence-repair',actionId:String(action.id),data:{reason:'Source evidence corrected',eventId:event.id}});
   }
   const stale=db.prepare("SELECT id,dedup_key FROM owner_notifications WHERE status='pending' AND (event_ref=? OR (category='briefing' AND instr(text,?)>0))").all(event.id,event.title);
   for(const n of stale){
    const key=String(n.dedup_key).replace(/#\d+$/,'');
    db.prepare("UPDATE owner_notifications SET status='pending',folded_into=NULL,updated_at=? WHERE status='folded' AND folded_into=? AND (event_ref IS NULL OR event_ref!=?)").run(now,key,event.id);
    report.notificationsDropped+=Number(db.prepare("UPDATE owner_notifications SET status='dropped',drop_reason='Source evidence corrected',updated_at=? WHERE id=? AND status='pending'").run(now,String(n.id)).changes);
   }
  }
  audit.append({type:'recovery',actor:'system:mail-evidence-repair',data:report});
  return report;
 });
}
