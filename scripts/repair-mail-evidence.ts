/** Dry-run by default. Stop the daemon before --apply; backup uses SQLite's consistent API. */
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {systemClock} from '../src/core/clock.ts';
import {repairMailEvidence} from '../src/daemon/repair-mail-evidence.ts';
import {daemonRunning} from '../src/daemon/daemon.ts';

const {values}=parseArgs({options:{home:{type:'string'},apply:{type:'boolean',default:false}}});
if(!values.home)throw new Error('An explicit --home is required');
const home=resolve(values.home),apply=values.apply===true;
if(apply&&daemonRunning(home))throw new Error('Stop the daemon before applying this repair');
const db=new DatabaseSync(join(home,'potts.db'),{readOnly:!apply});
try{
 db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
 if(apply){const dir=join(home,'backups','mail-evidence-repair');mkdirSync(dir,{recursive:true,mode:0o700});const path=join(dir,`before-${systemClock.nowIso().replace(/[:.]/g,'-')}.sqlite`);db.prepare('VACUUM INTO ?').run(path);chmodSync(path,0o600);console.log('Private pre-repair database backup saved.');}
 console.log(JSON.stringify(repairMailEvidence(db,systemClock,apply)));
}finally{db.close();}
