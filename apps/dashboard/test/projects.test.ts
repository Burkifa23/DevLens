import { beforeEach, expect, test } from "vitest";
import { createProject, getOwnedProject, hashKey, listProjects } from "@/lib/projects";
import { prisma } from "@/lib/db";

let userA: string;
let userB: string;

beforeEach(async () => {
  userA = (await prisma.user.create({ data: { email: "a@b.co", passwordHash: "x" } })).id;
  userB = (await prisma.user.create({ data: { email: "c@d.co", passwordHash: "x" } })).id;
});

test("secret key is returned once and stored hashed", async () => {
  const { project, secretKey } = await createProject(userA, "Demo", ["http://localhost:3001"]);
  expect(secretKey).toMatch(/^sk_[0-9a-f]{32}$/); expect(project.publicKey).toMatch(/^pk_[0-9a-f]{24}$/);
  expect(project.secretKeyHash).toBe(hashKey(secretKey)); expect(JSON.stringify(project)).not.toContain(secretKey);
});

test("another user's project is invisible", async () => {
  const { project } = await createProject(userA, "Demo", []);
  expect(await getOwnedProject(userB, project.id)).toBeNull();
  expect((await getOwnedProject(userA, project.id))?.id).toBe(project.id);
  expect(await listProjects(userB)).toEqual([]);
});

test("rejects malformed origins", async () => {
  await expect(createProject(userA, "x", ["not a url"])).rejects.toThrow("Invalid origin");
  await expect(createProject(userA, "x", ["javascript:alert(1)"])).rejects.toThrow("Invalid origin");
  await expect(createProject(userA, "x", ["ftp://files.example.com"])).rejects.toThrow("Invalid origin");
});

test("origins are normalized and de-duplicated", async () => {
  const { project } = await createProject(userA, "x", [" http://localhost:3001/ ", "http://localhost:3001/app?x=1", "", "HTTPS://Demo.Example.com"]);
  expect(project.allowedOrigins).toEqual(["http://localhost:3001", "https://demo.example.com"]);
});

test("repoUrl accepts GitHub repos only", async () => {
  await expect(createProject(userA, "x", [], "https://github.com/team/DevLens")).resolves.toBeDefined();
  for (const bad of ["javascript:alert(1)", "http://github.com/a/b", "https://evil.com/a/b", "https://github.com/a"])
    await expect(createProject(userA, "x", [], bad)).rejects.toThrow("Invalid repository URL");
});

test("project name is required and bounded", async () => {
  await expect(createProject(userA, "   ", [])).rejects.toThrow("Project name is required");
  await expect(createProject(userA, "x".repeat(101), [])).rejects.toThrow("Project name must be at most 100 characters");
  expect((await createProject(userA, "  Demo  ", [])).project.name).toBe("Demo");
});

test("every project gets its own keys", async () => {
  const one = await createProject(userA, "One", []);
  const two = await createProject(userA, "Two", []);
  expect(one.project.publicKey).not.toBe(two.project.publicKey);
  expect(one.secretKey).not.toBe(two.secretKey);
});

test("hashKey is SHA-256 hex", () => {
  expect(hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("listProjects returns the owner's projects, newest first, without the key hash", async () => {
  await createProject(userA, "Old", []);
  await createProject(userA, "New", []);
  const list = await listProjects(userA);
  expect(list.map((p) => p.name)).toEqual(["New", "Old"]);
  expect(list[0]).not.toHaveProperty("secretKeyHash");
});
