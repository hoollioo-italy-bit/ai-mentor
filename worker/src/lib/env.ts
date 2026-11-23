export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  APP_ENV: string;
  PRICE_PROVIDER: string;        // naver | kis | mock
  ADMIN_EMAIL: string;
  MAIL_FROM_NAME: string;
  DEV_USER: string;
  WEB_ORIGIN?: string;              // Pages 도메인(쉼표 구분). 미설정 시 CORS "*"
  RELAY_TOKEN: string;           // secret
  KIS_APP_KEY?: string;          // secret (Phase 4)
  KIS_APP_SECRET?: string;       // secret (Phase 4)
  KIS_BASE_URL?: string;
};

export type Vars = { userId: string };
export type AppEnv = { Bindings: Env; Variables: Vars };
