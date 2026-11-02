export type ExtensionTemplateIndustry =
  | "general"
  | "petrochemical"
  | "media"
  | "internet"
  | "construction"
  | "government"
  | "enterprise"
  | "public-institution"
  | "system-integration"
  | "education"
  | "finance"
  | "healthcare";

export type ExtensionTemplateWorkNature =
  | "office"
  | "writer"
  | "designer"
  | "programmer"
  | "engineer"
  | "researcher"
  | "teacher"
  | "accountant"
  | "legal"
  | "project-manager"
  | "product-manager"
  | "marketer"
  | "analyst"
  | "salesperson"
  | "hr"
  | "photographer";

export interface ExtensionTemplateOption<TId extends string> {
  id: TId;
  labelKey: string;
  descriptionKey: string;
}

export const EXTENSION_TEMPLATE_INDUSTRIES: ReadonlyArray<
  ExtensionTemplateOption<ExtensionTemplateIndustry>
> = [
  {
    id: "general",
    labelKey: "settingsExtensionTemplateIndustryGeneral",
    descriptionKey: "settingsExtensionTemplateIndustryGeneralDescription",
  },
  {
    id: "petrochemical",
    labelKey: "settingsExtensionTemplateIndustryPetrochemical",
    descriptionKey: "settingsExtensionTemplateIndustryPetrochemicalDescription",
  },
  {
    id: "media",
    labelKey: "settingsExtensionTemplateIndustryMedia",
    descriptionKey: "settingsExtensionTemplateIndustryMediaDescription",
  },
  {
    id: "internet",
    labelKey: "settingsExtensionTemplateIndustryInternet",
    descriptionKey: "settingsExtensionTemplateIndustryInternetDescription",
  },
  {
    id: "construction",
    labelKey: "settingsExtensionTemplateIndustryConstruction",
    descriptionKey: "settingsExtensionTemplateIndustryConstructionDescription",
  },
  {
    id: "government",
    labelKey: "settingsExtensionTemplateIndustryGovernment",
    descriptionKey: "settingsExtensionTemplateIndustryGovernmentDescription",
  },
  {
    id: "enterprise",
    labelKey: "settingsExtensionTemplateIndustryEnterprise",
    descriptionKey: "settingsExtensionTemplateIndustryEnterpriseDescription",
  },
  {
    id: "public-institution",
    labelKey: "settingsExtensionTemplateIndustryPublicInstitution",
    descriptionKey: "settingsExtensionTemplateIndustryPublicInstitutionDescription",
  },
  {
    id: "system-integration",
    labelKey: "settingsExtensionTemplateIndustrySystemIntegration",
    descriptionKey: "settingsExtensionTemplateIndustrySystemIntegrationDescription",
  },
  {
    id: "education",
    labelKey: "settingsExtensionTemplateIndustryEducation",
    descriptionKey: "settingsExtensionTemplateIndustryEducationDescription",
  },
  {
    id: "finance",
    labelKey: "settingsExtensionTemplateIndustryFinance",
    descriptionKey: "settingsExtensionTemplateIndustryFinanceDescription",
  },
  {
    id: "healthcare",
    labelKey: "settingsExtensionTemplateIndustryHealthcare",
    descriptionKey: "settingsExtensionTemplateIndustryHealthcareDescription",
  },
];

export const EXTENSION_TEMPLATE_WORK_NATURES: ReadonlyArray<
  ExtensionTemplateOption<ExtensionTemplateWorkNature>
> = [
  {
    id: "office",
    labelKey: "settingsExtensionTemplateWorkOffice",
    descriptionKey: "settingsExtensionTemplateWorkOfficeDescription",
  },
  {
    id: "writer",
    labelKey: "settingsExtensionTemplateWorkWriter",
    descriptionKey: "settingsExtensionTemplateWorkWriterDescription",
  },
  {
    id: "designer",
    labelKey: "settingsExtensionTemplateWorkDesigner",
    descriptionKey: "settingsExtensionTemplateWorkDesignerDescription",
  },
  {
    id: "programmer",
    labelKey: "settingsExtensionTemplateWorkProgrammer",
    descriptionKey: "settingsExtensionTemplateWorkProgrammerDescription",
  },
  {
    id: "engineer",
    labelKey: "settingsExtensionTemplateWorkEngineer",
    descriptionKey: "settingsExtensionTemplateWorkEngineerDescription",
  },
  {
    id: "researcher",
    labelKey: "settingsExtensionTemplateWorkResearcher",
    descriptionKey: "settingsExtensionTemplateWorkResearcherDescription",
  },
  {
    id: "teacher",
    labelKey: "settingsExtensionTemplateWorkTeacher",
    descriptionKey: "settingsExtensionTemplateWorkTeacherDescription",
  },
  {
    id: "accountant",
    labelKey: "settingsExtensionTemplateWorkAccountant",
    descriptionKey: "settingsExtensionTemplateWorkAccountantDescription",
  },
  {
    id: "legal",
    labelKey: "settingsExtensionTemplateWorkLegal",
    descriptionKey: "settingsExtensionTemplateWorkLegalDescription",
  },
  {
    id: "project-manager",
    labelKey: "settingsExtensionTemplateWorkProjectManager",
    descriptionKey: "settingsExtensionTemplateWorkProjectManagerDescription",
  },
  {
    id: "product-manager",
    labelKey: "settingsExtensionTemplateWorkProductManager",
    descriptionKey: "settingsExtensionTemplateWorkProductManagerDescription",
  },
  {
    id: "marketer",
    labelKey: "settingsExtensionTemplateWorkMarketer",
    descriptionKey: "settingsExtensionTemplateWorkMarketerDescription",
  },
  {
    id: "analyst",
    labelKey: "settingsExtensionTemplateWorkAnalyst",
    descriptionKey: "settingsExtensionTemplateWorkAnalystDescription",
  },
  {
    id: "salesperson",
    labelKey: "settingsExtensionTemplateWorkSalesperson",
    descriptionKey: "settingsExtensionTemplateWorkSalespersonDescription",
  },
  {
    id: "hr",
    labelKey: "settingsExtensionTemplateWorkHr",
    descriptionKey: "settingsExtensionTemplateWorkHrDescription",
  },
  {
    id: "photographer",
    labelKey: "settingsExtensionTemplateWorkPhotographer",
    descriptionKey: "settingsExtensionTemplateWorkPhotographerDescription",
  },
];

const INDUSTRY_EXTENSIONS: Record<ExtensionTemplateIndustry, readonly string[]> = {
  general: [
    ".csv", ".doc", ".docx", ".md", ".pdf", ".ppt", ".pptx", ".rtf", ".txt",
    ".xls", ".xlsx",
  ],
  petrochemical: [
    ".csv", ".doc", ".docx", ".dwg", ".dxf", ".eml", ".ifc", ".jpg", ".jpeg",
    ".md", ".pdf", ".png", ".ppt", ".pptx", ".rvt", ".sql", ".txt", ".xls", ".xlsx",
  ],
  media: [
    ".aep", ".ai", ".csv", ".docx", ".gif", ".indd", ".jpg", ".jpeg", ".md", ".mp3",
    ".mp4", ".mov", ".pdf", ".png", ".psd", ".svg", ".txt", ".wav", ".webp",
  ],
  internet: [
    ".css", ".csv", ".html", ".htm", ".js", ".json", ".md", ".pdf", ".png", ".scss",
    ".sql", ".svg", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
  ],
  construction: [
    ".csv", ".doc", ".docx", ".dwg", ".dxf", ".ifc", ".jpg", ".jpeg", ".pdf", ".png",
    ".pptx", ".rfa", ".rvt", ".skp", ".txt", ".xls", ".xlsx",
  ],
  government: [
    ".csv", ".doc", ".docx", ".eml", ".json", ".md", ".pdf", ".ppt", ".pptx", ".rtf",
    ".txt", ".xls", ".xlsx", ".xml", ".yaml", ".yml",
  ],
  enterprise: [
    ".csv", ".doc", ".docx", ".eml", ".html", ".json", ".md", ".msg", ".pdf", ".ppt",
    ".pptx", ".sql", ".txt", ".xls", ".xlsx", ".xml", ".yaml", ".yml",
  ],
  "public-institution": [
    ".csv", ".doc", ".docx", ".json", ".md", ".odt", ".pdf", ".ppt", ".pptx", ".rtf",
    ".txt", ".xls", ".xlsx", ".xml",
  ],
  "system-integration": [
    ".conf", ".csv", ".docx", ".drawio", ".ini", ".json", ".md", ".pdf", ".properties",
    ".sh", ".sql", ".txt", ".vsdx", ".xls", ".xlsx", ".xml", ".yaml", ".yml",
  ],
  education: [
    ".csv", ".docx", ".html", ".jpg", ".jpeg", ".md", ".mp3", ".mp4", ".pdf", ".png",
    ".pptx", ".txt", ".xls", ".xlsx",
  ],
  finance: [
    ".csv", ".doc", ".docx", ".json", ".pdf", ".sql", ".txt", ".xls", ".xlsx", ".xml",
  ],
  healthcare: [
    ".csv", ".dcm", ".docx", ".jpg", ".jpeg", ".json", ".pdf", ".png", ".txt", ".xls",
    ".xlsx", ".xml",
  ],
};

const WORK_NATURE_EXTENSIONS: Record<ExtensionTemplateWorkNature, readonly string[]> = {
  office: [
    ".csv", ".doc", ".docx", ".odt", ".pdf", ".ppt", ".pptx", ".rtf", ".txt",
    ".xls", ".xlsx",
  ],
  writer: [
    ".doc", ".docx", ".epub", ".html", ".htm", ".markdown", ".md", ".mdx", ".odt",
    ".pdf", ".rtf", ".txt", ".wps",
  ],
  designer: [
    ".ai", ".fig", ".gif", ".indd", ".jpg", ".jpeg", ".pdf", ".png", ".psd", ".sketch",
    ".svg", ".tif", ".tiff", ".webp",
  ],
  programmer: [
    ".bash", ".c", ".cc", ".cpp", ".css", ".cjs", ".dockerfile", ".env", ".go", ".h",
    ".hpp", ".html", ".htm", ".ini", ".java", ".js", ".json", ".jsx", ".less", ".log",
    ".md", ".mjs", ".py", ".rs", ".scss", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt",
    ".xml", ".yaml", ".yml", ".zsh",
  ],
  engineer: [
    ".csv", ".doc", ".docx", ".dwg", ".dxf", ".ifc", ".iges", ".igs", ".json", ".md",
    ".pdf", ".rfa", ".rvt", ".sql", ".step", ".stp", ".txt", ".xls", ".xlsx", ".xml",
    ".yaml", ".yml",
  ],
  researcher: [
    ".bib", ".csv", ".docx", ".ipynb", ".json", ".md", ".pdf", ".py", ".r", ".tex",
    ".txt", ".xls", ".xlsx", ".xml",
  ],
  teacher: [
    ".csv", ".docx", ".html", ".jpg", ".jpeg", ".md", ".mp3", ".mp4", ".pdf", ".png",
    ".pptx", ".txt", ".xls", ".xlsx",
  ],
  accountant: [
    ".csv", ".doc", ".docx", ".json", ".pdf", ".txt", ".xls", ".xlsx", ".xml",
  ],
  legal: [
    ".doc", ".docx", ".eml", ".html", ".md", ".msg", ".pdf", ".rtf", ".txt",
  ],
  "project-manager": [
    ".csv", ".docx", ".json", ".md", ".pdf", ".pptx", ".txt", ".xls", ".xlsx", ".yaml",
    ".yml",
  ],
  "product-manager": [
    ".csv", ".docx", ".html", ".json", ".md", ".pdf", ".png", ".pptx", ".txt", ".xls",
    ".xlsx",
  ],
  marketer: [
    ".csv", ".docx", ".jpg", ".jpeg", ".md", ".mp3", ".mp4", ".pdf", ".png", ".pptx",
    ".svg", ".txt", ".xls", ".xlsx",
  ],
  analyst: [
    ".csv", ".json", ".md", ".pdf", ".py", ".sql", ".txt", ".xls", ".xlsx", ".xml",
  ],
  salesperson: [
    ".csv", ".docx", ".jpg", ".jpeg", ".md", ".pdf", ".png", ".pptx", ".txt", ".xls",
    ".xlsx",
  ],
  hr: [
    ".csv", ".doc", ".docx", ".md", ".pdf", ".rtf", ".txt", ".xls", ".xlsx",
  ],
  photographer: [
    ".arw", ".cr2", ".cr3", ".dng", ".jpg", ".jpeg", ".nef", ".png", ".psd", ".tif",
    ".tiff", ".xmp",
  ],
};

export function getExtensionTemplateExtensions(
  industries: readonly ExtensionTemplateIndustry[],
  workNatures: readonly ExtensionTemplateWorkNature[],
): string[] {
  return Array.from(new Set([
    ...industries.flatMap((industry) => INDUSTRY_EXTENSIONS[industry]),
    ...workNatures.flatMap((workNature) => WORK_NATURE_EXTENSIONS[workNature]),
  ])).sort(compareExtensions);
}

function compareExtensions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}
