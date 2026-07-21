import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

type OwnedWebProjectOptions = {
  repositoryRoot: string;
  tempRoot?: string;
};

export type OwnedWebProject = {
  cleanup(): Promise<void>;
  distDir: string;
  outputPath: string;
  projectRoot: string;
  webRoot: string;
};

const distDir = ".milestone2-next";

export async function createOwnedWebProject({
  repositoryRoot,
  tempRoot,
}: OwnedWebProjectOptions): Promise<OwnedWebProject> {
  const sourceRepositoryRoot = path.resolve(repositoryRoot);
  const sourceWebRoot = path.join(sourceRepositoryRoot, "apps", "web");
  const ownedProjectsRoot = path.resolve(tempRoot ?? sourceRepositoryRoot);
  await mkdir(ownedProjectsRoot, { recursive: true });
  const projectRoot = await mkdtemp(
    path.join(ownedProjectsRoot, ".architect-milestone2-web-"),
  );
  const webRoot = path.join(projectRoot, "apps", "web");

  try {
    await mkdir(webRoot, { recursive: true });
    await Promise.all([
      cp(
        path.join(sourceRepositoryRoot, "tsconfig.base.json"),
        path.join(projectRoot, "tsconfig.base.json"),
      ),
      ...["next-env.d.ts", "next.config.ts", "package.json", "tsconfig.json"].map(
        (fileName) =>
          cp(
            path.join(sourceWebRoot, fileName),
            path.join(webRoot, fileName),
          ),
      ),
      cp(path.join(sourceWebRoot, "src"), path.join(webRoot, "src"), {
        recursive: true,
      }),
    ]);
    const outputPath = path.join(webRoot, distDir);
    await mkdir(outputPath, { recursive: true });
    return {
      async cleanup() {
        await rm(projectRoot, { force: true, recursive: true });
      },
      distDir,
      outputPath,
      projectRoot,
      webRoot,
    };
  } catch (error) {
    await rm(projectRoot, { force: true, recursive: true });
    throw error;
  }
}
