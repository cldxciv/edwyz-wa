export function filtersFrom(params: URLSearchParams) {
  const get = (k: string) => params.get(k) || undefined;
  return { status: get("status"), formId: get("formId"), campaign: get("campaign"), assignedToId: get("assignedToId"), from: get("from"), to: get("to") };
}
