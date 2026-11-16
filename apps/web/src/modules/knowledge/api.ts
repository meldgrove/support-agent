import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  KnowledgeSource,
  KnowledgeSourceCreate,
  KnowledgeSourceUpdate,
  KnowledgeTestResult,
} from "@support-agent/shared/api/knowledge";
import { api } from "@/lib/api";

export const knowledgeKeys = { all: ["knowledge"] as const, list: ["knowledge", "list"] as const };

/** Every signed-in role may read the list (the agent form picks from it). */
export function useKnowledgeSources() {
  return useQuery({
    queryKey: knowledgeKeys.list,
    queryFn: () => api.get<{ items: KnowledgeSource[] }>("/knowledge-sources").then((data) => data.items),
  });
}

export function useCreateKnowledgeSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: KnowledgeSourceCreate) => api.post<KnowledgeSource>("/knowledge-sources", input),
    onSuccess: () => client.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useUpdateKnowledgeSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: KnowledgeSourceUpdate & { id: string }) =>
      api.patch<KnowledgeSource>(`/knowledge-sources/${id}`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useDeleteKnowledgeSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/knowledge-sources/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useTestKnowledgeSource() {
  return useMutation({
    mutationFn: ({ id, query }: { id: string; query: string }) =>
      api.post<KnowledgeTestResult>(`/knowledge-sources/${id}/test`, { query }),
  });
}
