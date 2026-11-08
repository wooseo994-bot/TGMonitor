import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const defaults = { timezone:'Asia/Manila', start:'10:00', end:'19:00', minutes:30, size:4, frequency:2, weekdays:[1,2,3,4,5] };
export const key = () => randomBytes(24).toString('hex');
export function hash(password, salt = key()) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export function matches(password, saved) {
  const salt = saved.split(':')[0];
  return timingSafeEqual(Buffer.from(hash(password,salt)), Buffer.from(saved));
}
export function vault(secret) {
  const material = Buffer.from(secret,'hex');
  if (!/^[a-f\d]{64}$/i.test(secret)) throw Error('APP_KEY 必须为 64 位十六进制字符串');
  return {
    seal(value) {
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm',material,iv);
      const bytes = Buffer.concat([c.update(value), c.final()]);
      return [iv,c.getAuthTag(),bytes].map(b=>b.toString('hex')).join(':');
    },
    open(value) {
      const [iv,tag,bytes]=value.split(':').map(s=>Buffer.from(s,'hex'));
      const c=createDecipheriv('aes-256-gcm',material,iv);c.setAuthTag(tag);
      return Buffer.concat([c.update(bytes),c.final()]).toString();
    }
  };
}
export function database(path) {
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY,password TEXT NOT NULL,role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,email TEXT NOT NULL REFERENCES users,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,email TEXT NOT NULL,role TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT,active INTEGER NOT NULL DEFAULT 1,eligible INTEGER NOT NULL DEFAULT 0,away INTEGER NOT NULL DEFAULT 0,last_picked INTEGER);
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY, status TEXT NOT NULL, chat TEXT NOT NULL, created INTEGER NOT NULL, sent INTEGER, deadline INTEGER, message TEXT, kind TEXT NOT NULL, policy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS targets(batch TEXT NOT NULL REFERENCES batches,id TEXT NOT NULL,name TEXT NOT NULL,username TEXT,confirmed INTEGER,exempt INTEGER DEFAULT 0,review TEXT,note TEXT,PRIMARY KEY(batch,id));
    CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule(day TEXT PRIMARY KEY,times TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,ts INTEGER,actor TEXT,action TEXT,detail TEXT);`);
  return db;
}
export function localTime(at,zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(at).map(p=>[p.type,p.value]));
  return {day:parts.year+'-'+parts.month+'-'+parts.day,clock:parts.hour+':'+parts.minute,weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday)};
}
export const minutes = v => Number(v.slice(0,2))*60 + Number(v.slice(3));
export function within(at,rule) {
  const local=localTime(at,rule.timezone), minute=minutes(local.clock);
  return rule.weekdays.includes(local.weekday)&&minute>=minutes(rule.start)&&minute+rule.minutes<=minutes(rule.end);
}
export function outcome(row, now=Date.now()) {
  if(row.exempt || row.review==='excluded') return '豁免';
  if(row.confirmed) return row.confirmed<=row.deadline?'按时确认':'迟到确认';
  if(row.status==='done'||(row.status==='sent'&&now>row.deadline)) return '未按时确认';
  return row.status==='sent'?'待确认':'未发送';
}
