export interface MaasModel {
  id: string;
  displayName: string;
  modelName: string;
}

export interface MaasProvider {
  key: string;
  label: string;
  baseUrl: string;
  authEnvKey: string;
  models: MaasModel[];
}

export type MaasRegistry = MaasProvider[];
