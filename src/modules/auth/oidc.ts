import * as oidc from "openid-client";

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  amr: string[];
  acr?: string;
}

export interface OidcStartParameters {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
}

export interface OidcCallbackParameters {
  callbackUrl: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcAdapter {
  begin(parameters: OidcStartParameters): Promise<URL>;
  complete(parameters: OidcCallbackParameters): Promise<OidcIdentity>;
}

export interface OidcClientSettings {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

export function createOidcAdapter(settings: OidcClientSettings): OidcAdapter {
  let configurationPromise: Promise<oidc.Configuration> | undefined;
  const configuration = (): Promise<oidc.Configuration> => {
    configurationPromise ??= oidc
      .discovery(
        new URL(settings.issuerUrl),
        settings.clientId,
        settings.clientSecret,
      )
      .catch((error: unknown) => {
        configurationPromise = undefined;
        throw error;
      });
    return configurationPromise;
  };

  return {
    async begin(parameters) {
      const config = await configuration();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(
        parameters.codeVerifier,
      );
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: parameters.redirectUri,
        scope: parameters.scopes.join(" "),
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: parameters.state,
        nonce: parameters.nonce,
      });
    },

    async complete(parameters) {
      const config = await configuration();
      const tokens = await oidc.authorizationCodeGrant(
        config,
        parameters.callbackUrl,
        {
          expectedState: parameters.state,
          expectedNonce: parameters.nonce,
          pkceCodeVerifier: parameters.codeVerifier,
        },
      );
      const claims = tokens.claims();
      if (!claims) throw new Error("OIDC identity claims are missing");
      const issuer = typeof claims.iss === "string" ? claims.iss : "";
      const subject = typeof claims.sub === "string" ? claims.sub : "";
      if (!issuer || !subject)
        throw new Error("OIDC identity claims are missing");

      const amr = Array.isArray(claims.amr)
        ? claims.amr.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return {
        issuer,
        subject,
        ...(typeof claims.email === "string" ? { email: claims.email } : {}),
        ...(typeof claims.name === "string" ? { name: claims.name } : {}),
        amr,
        ...(typeof claims.acr === "string" ? { acr: claims.acr } : {}),
      };
    },
  };
}
