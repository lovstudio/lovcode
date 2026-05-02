export interface Vendor {
  id: string;
  name: string;
  iconUrl?: string;
  description?: string;
  websiteUrl?: string;
}

export interface MaasModel {
  id: string;
  displayName: string;
  modelName: string;
  /** References Vendor.id on the parent MaasProvider's vendors list. */
  vendor?: string;
  description?: string;
  iconUrl?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  contextWindow?: number;
}

export interface MaasProvider {
  key: string;
  label: string;
  baseUrl: string;
  /** API key / bearer token in plaintext. */
  authToken: string;
  models: MaasModel[];
  vendors?: Vendor[];
  fetchCommand?: string;
  /** ISO timestamp of the most recent successful Verify. */
  lastVerifiedAt?: string;
  /** Fingerprint of the token at the moment of the last successful Verify. */
  lastVerifiedTokenHash?: string;
}

export type MaasRegistry = MaasProvider[];
