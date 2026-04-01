import type { Skill } from "./types.ts";
import { join } from "@std/path";
import { getSkillsDir } from "../shared/helpers.ts";
import { log } from "../shared/log.ts";
import {
  listWorkspaceKvFiles,
  readWorkspaceKv,
} from "./tools/file_workspace.ts";

export interface SkillLoader {
  loadSkills(): Promise<void>;
  getSkills(): Skill[];
  getSkill(name: string): Skill | undefined;
  reload(): Promise<void>;
}

abstract class BaseSkillLoader implements SkillLoader {
  protected readonly skills: Map<string, Skill> = new Map();

  abstract loadSkills(): Promise<void>;

  protected parseSkillContent(content: string, path: string): Skill {
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

export class SkillsLoader extends BaseSkillLoader {
  private readonly skillsDir: string;

  constructor(skillsDir?: string) {
    super();
    this.skillsDir = skillsDir ?? getSkillsDir();
  }

  override async loadSkills(): Promise<void> {
    try {
      await Deno.stat(this.skillsDir);
    } catch {
      log.debug(`Skills directory does not exist: ${this.skillsDir}`);
      return;
    }

    try {
      for await (const entry of Deno.readDir(this.skillsDir)) {
        if (!entry.isFile || !entry.name.endsWith(".md")) continue;
        const path = join(this.skillsDir, entry.name);
        const skill = await this.parseSkillFile(path);
        if (skill) this.skills.set(skill.name, skill);
      }
      log.info(`${this.skills.size} skill(s) loaded`);
    } catch (e) {
      log.error("Failed to load skills", e);
    }
  }

  private async parseSkillFile(path: string): Promise<Skill | null> {
    try {
      const content = await Deno.readTextFile(path);
      return this.parseSkillContent(content, path);
    } catch (e) {
      log.error(`Failed to read skill ${path}`, e);
      return null;
    }
  }
}

export class KvSkillsLoader extends BaseSkillLoader {
  constructor(
    private readonly kv: Deno.Kv,
    private readonly agentId: string,
  ) {
    super();
  }

  override async loadSkills(): Promise<void> {
    try {
      const filenames = await listWorkspaceKvFiles(
        this.kv,
        this.agentId,
        "skills",
      );

      for (const filename of filenames) {
        if (!filename.endsWith(".md")) continue;
        const path = `skills/${filename}`;
        const content = await readWorkspaceKv(this.kv, this.agentId, path);
        if (content === null) continue;
        const skill = this.parseSkillContent(content, path);
        this.skills.set(skill.name, skill);
      }

      log.info(`${this.skills.size} skill(s) loaded from KV`);
    } catch (e) {
      log.error("Failed to load skills from KV", e);
    }
  }
}

export class EmptySkillLoader extends BaseSkillLoader {
  constructor(private readonly reason: string) {
    super();
  }

  override loadSkills(): Promise<void> {
    log.warn(this.reason);
    return Promise.resolve();
  }
}
