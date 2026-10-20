import {test} from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync} from 'node:crypto';
import {encryptSnapshot,decryptSnapshot} from '../scripts/backup_crypto.mjs';
test('backups encrypt private fields, round trip and reject tampering or another recovery key',()=>{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}),snapshot={tables:{tix_watches:[{owner_email:'private@example.test',threshold_cents:7500}]}};
 const sealed=encryptSnapshot(snapshot,keys.publicKey);assert.ok(!JSON.stringify(sealed).includes('private@example.test'));assert.deepEqual(decryptSnapshot(sealed,keys.privateKey),snapshot);
 const altered={...sealed,ciphertext:Buffer.from('tampered').toString('base64')};assert.throws(()=>decryptSnapshot(altered,keys.privateKey));
 const other=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'}});assert.throws(()=>decryptSnapshot(sealed,other.privateKey));
});
