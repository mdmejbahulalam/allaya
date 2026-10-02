import type { HandlerRegistry } from '../registry';
import type { SkillsService } from '../../services/skills-service';

export function registerSkillsHandlers(registry: HandlerRegistry, skills: SkillsService): void {
  registry
    .register('skills:catalog', () => skills.catalog())
    .register('skills:saveCustom', (input) => skills.saveCustom(input))
    .register('skills:deleteCustom', ({ id }) => {
      skills.deleteCustom(id);
      return { ok: true as const };
    })
    .register('skills:saveBrand', (brand) => skills.saveBrand(brand));
}
