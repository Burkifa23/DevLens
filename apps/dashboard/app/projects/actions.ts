"use server";

import { revalidatePath } from "next/cache";
import { createProject, ProjectInputError } from "@/lib/projects";
import { requireUserId } from "@/lib/session";

/** What the create-project form shows: an error, or the new keys (the secret one only this once). */
export type CreateProjectState = {
  error?: string;
  /** What the user typed, sent back with an error so React's post-submit form reset doesn't erase it. */
  values?: { name: string; origins: string; repoUrl: string };
  created?: { id: string; name: string; publicKey: string; secretKey: string };
};

/**
 * Create-project form action. Re-checks the session itself (the proxy is only
 * an early redirect), then creates the project for the signed-in user.
 *
 * The secret key travels back to the browser in this one response and is never
 * stored or retrievable again; only its hash is in the database.
 */
export async function createProjectAction(_prev: CreateProjectState, formData: FormData): Promise<CreateProjectState> {
  const userId = await requireUserId();
  const values = {
    name: String(formData.get("name") ?? ""),
    origins: String(formData.get("origins") ?? ""),
    repoUrl: String(formData.get("repoUrl") ?? ""),
  };
  try {
    const { project, secretKey } = await createProject(
      userId,
      values.name,
      values.origins.split(/\r?\n/), // one origin per line
      values.repoUrl,
    );
    revalidatePath("/projects");
    return { created: { id: project.id, name: project.name, publicKey: project.publicKey, secretKey } };
  } catch (e) {
    if (e instanceof ProjectInputError) return { error: e.message, values };
    throw e;
  }
}
