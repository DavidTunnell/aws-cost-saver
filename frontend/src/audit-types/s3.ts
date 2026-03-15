import { registerAuditUI } from "../audit-registry";

registerAuditUI({
  key: "s3",
  label: "S3",
  resourceNoun: "buckets",
  buttonColor: "bg-blue-600 hover:bg-blue-700",
  badgeStyle: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800",
  categoryLabels: {
    "s3-no-lifecycle": "No Lifecycle Policy",
    "s3-all-standard": "All Standard Storage",
    "s3-incomplete-multipart": "Incomplete Multipart Uploads",
    "s3-versioning-no-lifecycle": "Versioning Without Lifecycle",
    "s3-glacier-candidate": "Glacier Candidate",
    "s3-no-intelligent-tiering": "No Intelligent-Tiering",
    "s3-access-pattern-optimize": "Access Pattern Optimization",
    "s3-consolidation": "Bucket Consolidation",
  },
});
