export const JOB_TEMPLATES = [
  "legal",
  "finance",
  "creative",
  "technical",
  "code",
] as const;

export type JobTemplate = (typeof JOB_TEMPLATES)[number];

export type BeeZillaJob = {
  id: string;
  userId: string;
  template: JobTemplate | null;
  problem: string;
  createdAt: string;
  completedAt: string | null;
};

export function createJob(
  userId: string,
  input: { template?: JobTemplate | null; problem?: string } = {},
): BeeZillaJob {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    userId,
    template: input.template ?? null,
    problem: (input.problem || "").trim(),
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

export function isComplete(job: BeeZillaJob): boolean {
  return job.completedAt != null;
}

export function listJobs(
  jobs: BeeZillaJob[],
  userId: string,
  opts: { hideCompleted?: boolean } = {},
): BeeZillaJob[] {
  let out = jobs.filter((j) => j.userId === userId);
  if (opts.hideCompleted) out = out.filter((j) => !isComplete(j));
  return out.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function completeJob(job: BeeZillaJob, at = new Date().toISOString()): BeeZillaJob {
  return { ...job, completedAt: at };
}
