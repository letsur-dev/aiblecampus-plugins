/**
 * 기기 로그인 DPoP 키(RFC 9449). 키는 P-256 개인 JWK로 기기 Credential 파일(device.json)에 남는다(0.38.0까지와 같은 모양).
 * - 토큰 요청(기기 코드 polling, refresh)의 proof는 openid-client가 만든다(dpopKeyPair로 넘긴다)
 * - api. 요청의 proof(ath 포함)는 jose로 서명한다. openid-client의 fetchProtectedResource는 multipart 업로드 본문(FormData)을 받지 않아 쓰지 않는다
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type JsonWebKey, type webcrypto } from "node:crypto";
import { SignJWT, base64url, calculateJwkThumbprint } from "jose";

const ES256 = { name: "ECDSA", namedCurve: "P-256" } as const;

type DpopPrivateJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
};

type DpopPublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

function isPrivateJwk(value: JsonWebKey): value is DpopPrivateJwk {
  return value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" && value.x !== "" &&
    typeof value.y === "string" && value.y !== "" &&
    typeof value.d === "string" && value.d !== "";
}

export function generateDpopPrivateJwk(): DpopPrivateJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  if (!isPrivateJwk(jwk)) throw new Error("DPoP 기기 키를 만들지 못했다");
  return jwk;
}

function publicDpopJwk(privateJwk: JsonWebKey): DpopPublicJwk {
  if (!isPrivateJwk(privateJwk)) throw new Error("DPoP 기기 키 형식이 올바르지 않다");
  return { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y };
}

/** openid-client getDPoPHandle에 넘길 키 쌍. 공개 키는 proof 머리(jwk)에 넣으려고 내보낼 수 있게 가져온다 */
export async function dpopKeyPair(privateJwk: JsonWebKey): Promise<webcrypto.CryptoKeyPair> {
  if (!isPrivateJwk(privateJwk)) throw new Error("DPoP 기기 키 형식이 올바르지 않다");
  const { kty, crv, x, y, d } = privateJwk;
  return {
    privateKey: await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, ES256, false, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", { kty, crv, x, y }, ES256, true, ["verify"]),
  };
}

/** api. 요청에 붙이는 DPoP proof. htu는 query와 fragment를 뺀 주소, ath는 access token의 SHA-256 */
export async function createDpopProof(args: { privateJwk: JsonWebKey; method: string; url: string; accessToken: string }): Promise<string> {
  const url = new URL(args.url);
  const ath = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(args.accessToken))));
  return new SignJWT({ htm: args.method.toUpperCase(), htu: `${url.origin}${url.pathname}`, ath })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: publicDpopJwk(args.privateJwk) })
    .setIssuedAt()
    .setJti(randomUUID())
    .sign((await dpopKeyPair(args.privateJwk)).privateKey);
}

/** 서버가 토큰에 묶는 키 지문(RFC 7638 jkt) */
export function dpopKeyThumbprint(privateJwk: JsonWebKey): Promise<string> {
  return calculateJwkThumbprint(publicDpopJwk(privateJwk), "sha256");
}

export function assertDpopPrivateJwk(value: JsonWebKey): void {
  if (!isPrivateJwk(value)) throw new Error("DPoP 기기 키 형식이 올바르지 않다");
  createPublicKey(createPrivateKey({ key: value, format: "jwk" }));
}
