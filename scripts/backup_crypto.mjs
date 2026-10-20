import {randomBytes,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,createHash,constants} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
export function encryptSnapshot(snapshot,publicKey){
 const key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot)))),cipher.final()]);
 return {format:'ticketline-rsa-oaep-sha256-aes256gcm-v1',key_fingerprint:createHash('sha256').update(publicKey).digest('hex'),wrapped_key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function decryptSnapshot(envelope,privateKey){
 if(envelope.format!=='ticketline-rsa-oaep-sha256-aes256gcm-v1')throw Error('Unsupported backup format');
 const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrapped_key,'base64'));
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
 const compressed=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);
 return JSON.parse(gunzipSync(compressed,{maxOutputLength:256*1024*1024}));
}
