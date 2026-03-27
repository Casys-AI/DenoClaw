import type { Skill } from "./types.ts";
import { join } from "@std/path";
import { getSkillsDir } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";

export class SkillsLoader {
  private skillsDir: string;
  private skills = new Map<string, Skill>();

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || getSkillsDir();
  }

  async loadSkills(): Promise<void> {
    try {
      await Deno.stat(this.skillsDir);
    } catch {
      log.debug(`Répertoire skills inexistant : ${this.skillsDir}`);
      return;
    }

    try {
      for await (const entry of Deno.readDir(this.skillsDir)) {
        if (entry.isFile && entry.name.endsWith(".md")) {
          const path = join(this.skillsDir, entry.name);
          const skill = await this.parseSkillFile(path);
          if (skill) this.skills.set(skill.name, skill);
        }
      }
      log.info(`${this.skills.size} skill(s) chargé(s)`);
    } catch (e) {
      log.error("Échec chargement skills", e);
    }
  }

  private async parseSkillFile(path: string): Promise<Skill | null> {
    try {
      const content = await Deno.readTextFile(path);
      const lines = content.split("\n");

      let name = "";
      let description = "";

      for (const line of lines) {
        if (line.startsWith("# ")) {
          name = line.slice(2).trim();
        } else if (name && line.trim() && !line.startsWith("#")) {
          description = line.trim();
          break;
        }
      }

      if (!name) {
        name = path.split("/").pop()?.replace(".md", "") || "unknown";
      }

      return {
        name,
        description: description || "No description",
        content,
        path,
      };
    } catch (e) {
      log.error(`Échec lecture skill ${path}`, e);
      return null;
    }
  }

  getSkills(): Skill[] {
    return [...this.skills.values()];
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  async reload(): Promise<void> {
    this.skills.clear();
    await this.loadSkills();
  }
}
