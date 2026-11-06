import { FileCode2, FileText, Globe, Shapes, type LucideIcon } from "lucide-react";
import type { ArtifactType } from "@dispatch/shared";

export function artifactIcon(type: ArtifactType): LucideIcon {
  if (type === "svg") return Shapes;
  if (type === "markdown") return FileText;
  if (type === "code") return FileCode2;
  return Globe;
}

export function artifactTypeLabel(type: ArtifactType, language?: string): string {
  if (type === "html") return "HTML";
  if (type === "svg") return "SVG";
  if (type === "markdown") return "Document";
  return language ? `Code · ${language}` : "Code";
}
