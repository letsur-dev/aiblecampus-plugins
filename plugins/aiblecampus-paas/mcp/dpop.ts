import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type JsonWebKey,
} from "node:crypto";

type DpopPrivateJwk = JsonWebKey & {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
};

type DpopPublicJwk = Omit<DpopPrivateJwk, "d">;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function normalizedHtu(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

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

export function publicDpopJwk(privateJwk: JsonWebKey): DpopPublicJwk {
  if (!isPrivateJwk(privateJwk)) throw new Error("DPoP 기기 키 형식이 올바르지 않다");
  return {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
  };
}

export function dpopJwkThumbprint(publicJwk: DpopPublicJwk): string {
  const canonical = JSON.stringify({
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

export function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("base64url");
}

export function createDpopProof(args: {
  privateJwk: JsonWebKey;
  method: string;
  url: string;
  accessToken?: string;
  now?: () => number;
  jti?: string;
}): string {
  const publicJwk = publicDpopJwk(args.privateJwk);
  const header = encodeJson({
    alg: "ES256",
    typ: "dpop+jwt",
    jwk: publicJwk,
  });
  const payload = encodeJson({
    htm: args.method.toUpperCase(),
    htu: normalizedHtu(args.url),
    iat: Math.floor((args.now ?? Date.now)() / 1000),
    jti: args.jti ?? randomUUID(),
    ...(args.accessToken === undefined
      ? {}
      : { ath: accessTokenHash(args.accessToken) }),
  });
  const signature = sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    {
      key: createPrivateKey({ key: args.privateJwk, format: "jwk" }),
      dsaEncoding: "ieee-p1363",
    },
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function dpopKeyThumbprint(privateJwk: JsonWebKey): string {
  return dpopJwkThumbprint(publicDpopJwk(privateJwk));
}

export function assertDpopPrivateJwk(value: JsonWebKey): void {
  if (!isPrivateJwk(value)) throw new Error("DPoP 기기 키 형식이 올바르지 않다");
  createPublicKey(createPrivateKey({ key: value, format: "jwk" }));
}
