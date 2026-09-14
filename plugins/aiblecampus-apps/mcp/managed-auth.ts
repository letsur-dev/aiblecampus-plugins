import { createHash, createPrivateKey, randomUUID, sign, type JsonWebKey } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { appsEnv } from "./config.ts";
import { assertDpopPrivateJwk, createDpopProof, dpopKeyThumbprint, publicDpopJwk } from "./dpop.ts";

type Profile={version:1;id:string;secret:string;subject:string;account:string;issuer:string;apiBase:string;runtime:"code"|"cowork";expiresAt:string;machineKey:JsonWebKey;runtimeKey:JsonWebKey};
const cached=new Map<string,{token:string;expiresAt:number}>();
const pending=new Map<string,Promise<{token:string;expiresAt:number}>>();
const digest=(value:string)=>createHash("sha256").update(value).digest("base64url");
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString("base64url");

export function enrollmentProof(key:JsonWebKey,peer:string,profile:Pick<Profile,"id"|"secret"|"runtime"|"issuer">) {
  const header=encode({alg:"ES256",typ:"aible-enrollment+jwt",jwk:publicDpopJwk(key)});
  const payload=encode({htu:`${profile.issuer}/device/enrollment/token`,htm:"POST",iat:Math.floor(Date.now()/1000),jti:randomUUID(),enrollmentId:profile.id,runtime:profile.runtime,secretHash:digest(profile.secret),peer});
  const signature=sign("sha256",Buffer.from(`${header}.${payload}`),{key:createPrivateKey({key,format:"jwk"}),dsaEncoding:"ieee-p1363"}).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function exchange(profile:Profile) {
  const response=await fetch(`${profile.issuer}/device/enrollment/token`,{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(20000),headers:{"content-type":"application/json"},
    body:JSON.stringify({id:profile.id,secret:profile.secret,runtime:profile.runtime,
      machineProof:enrollmentProof(profile.machineKey,dpopKeyThumbprint(profile.runtimeKey),profile),
      runtimeProof:enrollmentProof(profile.runtimeKey,dpopKeyThumbprint(profile.machineKey),profile)}),
  });
  if(!response.ok)throw Error("Managed device registration rejected. Contact the event operator.");
  const body=await response.json() as Record<string,unknown>;
  if(body["subject"]!==profile.subject || body["token_type"]!=="DPoP" || typeof body["access_token"]!=="string" ||
     typeof body["expires_in"]!=="number" || body["expires_in"]<=0 || body["expires_in"]>300)throw Error("Managed device response did not match this participant.");
  return {token:body["access_token"],expiresAt:Date.now()+body["expires_in"]*1000};
}

/** A provisioned profile takes precedence; failures never fall back to another account. */
export async function managedRequestHeaders(apiBase:string,url:string,method:string):Promise<Record<string,string>|null>{
  const file=appsEnv("MANAGED_PROFILE");if(!file)return null;
  try {
    const raw=await readFile(file,"utf8");if(Buffer.byteLength(raw)>32768)throw Error("oversize");
    const profile=JSON.parse(raw) as Profile;
    if(profile.version!==1 || !["code","cowork"].includes(profile.runtime) || typeof profile.secret!=="string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(profile.secret) || typeof profile.subject!=="string" ||
      profile.apiBase.replace(/\/+$/,"")!==apiBase.replace(/\/+$/,"") || new URL(profile.issuer).protocol!=="https:" ||
      new URL(profile.issuer).origin!==profile.issuer || new URL(url).origin!==new URL(apiBase).origin ||
      !Number.isFinite(Date.parse(profile.expiresAt)) || Date.parse(profile.expiresAt)<=Date.now())throw Error("invalid profile");
    assertDpopPrivateJwk(profile.machineKey);assertDpopPrivateJwk(profile.runtimeKey);
    const key=digest(raw);let credential=cached.get(key);
    if(!credential || credential.expiresAt<=Date.now()+30000){
      let inflight=pending.get(key);
      if(!inflight){inflight=exchange(profile).finally(()=>pending.delete(key));pending.set(key,inflight);}
      credential=await inflight;cached.set(key,credential);
    }
    return {authorization:`DPoP ${credential.token}`,dpop:createDpopProof({privateJwk:profile.runtimeKey,method,url,accessToken:credential.token})};
  }catch{throw Error("Managed Apps authentication failed. Ask the event operator to check this laptop registration.");}
}

/** Optional installer receipt. Only a successful, matching whoami can produce it. */
export async function recordManagedCheck(account:unknown):Promise<void>{
  const file=appsEnv("MANAGED_PROFILE"),receipt=appsEnv("SETUP_RECEIPT");if(!file||!receipt)return;
  const profile=JSON.parse(await readFile(file,"utf8")) as Profile;
  if(typeof account!=="string"||account!==profile.account)throw Error("Managed participant account mismatch.");
  const temporary=`${receipt}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify({runtime:profile.runtime,account,subject:profile.subject,verifiedAt:new Date().toISOString()}),{mode:0o600});
  await rename(temporary,receipt);
}
