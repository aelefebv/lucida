// Mirror of `lucida_core::auth_principal::AuthPrincipal`. Kept as a
// hand-written type rather than imported from `lucida-core` (the WASM
// crate) because nothing in the auth path needs to cross the WASM
// boundary — auth is a server concern that the web client only
// observes.

export interface AuthPrincipal {
  email: string;
  display_name: string;
  picture_url: string | null;
  is_admin: boolean;
}

export type AuthState =
  | { status: "loading" }
  | { authenticated: true; principal: AuthPrincipal }
  | { authenticated: false; signedOut?: boolean };
