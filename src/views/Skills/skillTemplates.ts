import type { LocalSkill, MarketplaceMeta, TemplateComponent } from "../../types";

function hasMetaValue(meta: MarketplaceMeta): boolean {
  return Object.values(meta).some((value) => value !== null && value !== undefined && value !== "");
}

export function getSkillMarketplaceMeta(skill: LocalSkill): MarketplaceMeta | null {
  if (skill.marketplace && hasMetaValue(skill.marketplace)) {
    return skill.marketplace;
  }

  const flattened: MarketplaceMeta = {
    source_id: skill.source_id ?? null,
    source_name: skill.source_name ?? null,
    vendor: skill.vendor ?? null,
    author: skill.author ?? null,
    homepage: skill.homepage ?? null,
    downloads: skill.downloads ?? null,
    template_path: skill.template_path ?? null,
  };

  return hasMetaValue(flattened) ? flattened : null;
}

export function isMarketplaceLinkedSkill(skill: LocalSkill): boolean {
  const meta = getSkillMarketplaceMeta(skill);
  return Boolean(meta?.source_id && meta.source_id !== "personal");
}

export function skillToTemplate(skill: LocalSkill): TemplateComponent {
  const meta = getSkillMarketplaceMeta(skill);

  return {
    name: skill.name,
    path: skill.path,
    category: "skill",
    component_type: "skill",
    description: skill.description,
    downloads: meta?.downloads ?? null,
    content: skill.content,
    source_id: meta?.source_id ?? null,
    source_name: meta?.source_name ?? meta?.vendor ?? null,
    author: meta?.author ?? null,
  };
}
