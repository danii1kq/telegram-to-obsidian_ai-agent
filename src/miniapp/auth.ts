import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The check of the Telegram Web App data.
 *
 * The Mini App sends the `initData` string it got from Telegram. The backend
 * signs it with the bot token and compares the result with the hash Telegram
 * put into the string, so nobody can read the notes without being the owner.
 */

export interface TelegramUser {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface InitDataResult {
  ok: boolean;
  user?: TelegramUser;
  error?: string;
}

/** The key of the secret: HMAC_SHA256(bot_token, "WebAppData"). */
function secretKey(botToken: string): Buffer {
  return createHmac("sha256", "WebAppData").update(botToken).digest();
}

/** Checks the `initData` of a Mini App. */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86_400,
): InitDataResult {
  if (!initData) return { ok: false, error: "no init data" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "no hash in the init data" };

  const pairs: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }

  // The string of the check holds every field but the hash. Telegram adds a
  // signature for the check by a third party, and different versions of the
  // clients put it into the string or not, so both variants are tried.
  const withSignature = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const withoutSignature = withSignature.filter(([key]) => key !== "signature");

  const given = Buffer.from(hash, "hex");
  for (const variant of [withoutSignature, withSignature]) {
    const check = variant.map(([key, value]) => `${key}=${value}`).join("\n");
    const expected = createHmac("sha256", secretKey(botToken)).update(check).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      const authDate = Number(params.get("auth_date") ?? "0");
      if (!Number.isFinite(authDate) || authDate <= 0) {
        return { ok: false, error: "no auth date in the init data" };
      }
      if (Date.now() / 1000 - authDate > maxAgeSeconds) {
        return { ok: false, error: "the init data is too old" };
      }
      return { ok: true, user: readUser(params.get("user")) };
    }
  }

  return { ok: false, error: "the signature of the init data does not match" };
}

/**
 * Reads the user of the Mini App.
 *
 * The value comes from a string that Telegram signed, so it is well formed in
 * practice. It is still read field by field: the signature proves the string
 * came from Telegram, and the id is the only thing the access check has to go
 * on, so a missing or non numeric id must not turn into a user.
 */
function readUser(raw: string | null): TelegramUser | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const fields = parsed as Record<string, unknown>;
  const id = fields.id;
  if (typeof id !== "number" || !Number.isInteger(id)) return undefined;

  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  return {
    id,
    firstName: text(fields.first_name),
    lastName: text(fields.last_name),
    username: text(fields.username),
    languageCode: text(fields.language_code),
  };
}
