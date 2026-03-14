# AWS Cost Saver

Analyzes your AWS infrastructure for cost savings opportunities using Claude AI. Manage multiple AWS accounts through a web UI, run audits across seven service types (or all at once with Full Audit), and get actionable recommendations with estimated savings. Mark recommendations as fixed or incorrect and those resolutions carry forward to future audits automatically.

## Supported audits

### EC2
- **Right-sizing**: Instances with low CPU/network usage that could use smaller types
- **Idle instances**: Running instances with near-zero utilization
- **Old generations**: m4, c4, t2, etc. that should upgrade to current-gen for better price/performance
- **Stopped instances**: Still incurring EBS costs
- **Orphan EBS volumes**: Unattached volumes you're paying for
- **Idle Elastic IPs**: Unassociated EIPs costing ~$3.65/month each
- **Graviton migration**: x86 instances that could run on cheaper ARM-based Graviton
- **Snapshot cleanup**: Old or unnecessary EBS snapshots
- **Schedule stop**: Non-production instances that could be stopped outside business hours
- **Reserved Instances / Savings Plans**: Consistent usage that would benefit from commitments

### RDS
- **Idle databases**: Running instances with near-zero connections
- **Old generations**: db.m4, db.r4, etc. that should upgrade to current-gen
- **Right-sizing**: Over-provisioned instance classes based on CPU/memory usage
- **GP2 → GP3 storage**: Older storage type that can be upgraded for better price/performance
- **Multi-AZ non-prod**: Dev/test databases paying for unnecessary high availability
- **Stopped databases**: Auto-restarted after 7 days, still incurring costs
- **Snapshot cleanup**: Old manual snapshots and cluster snapshots
- **Backup retention**: Excessive retention periods on low-priority databases
- **Reserved Instances**: Steady-state databases that would benefit from reservations
- **Aurora migration**: RDS MySQL/PostgreSQL that could move to Aurora for better efficiency
- **Extended support surcharge**: Databases on end-of-life engine versions incurring extra fees
- **IOPS overprovisioned**: Provisioned IOPS exceeding actual usage
- **Underused read replicas**: Replicas with minimal query traffic
- **Serverless migration**: Low/variable-traffic databases suited for Aurora Serverless

### S3
- **No lifecycle policy**: Buckets without automatic data management rules
- **All Standard storage**: Buckets with data that could tier to cheaper storage classes
- **Incomplete multipart uploads**: Abandoned uploads consuming storage
- **Versioning without lifecycle**: Version-enabled buckets with no expiration rules
- **Glacier candidates**: Infrequently accessed data suited for archive storage
- **Intelligent-Tiering**: Buckets with unpredictable access patterns
- **Access pattern optimization**: Storage class adjustments based on actual usage
- **Bucket consolidation**: Many small buckets that could merge to reduce overhead

### NAT Gateway
- **Idle NAT Gateways**: Gateways with no traffic
- **Low utilization**: Gateways processing minimal data relative to their fixed hourly cost
- **Missing VPC Endpoints**: S3/DynamoDB traffic routed through NAT instead of free VPC endpoints
- **Redundant gateways**: Multiple gateways where fewer would suffice
- **Architecture optimization**: Cross-AZ traffic patterns and placement improvements

### Lambda
- **Unused functions**: Zero invocations in monitoring period
- **Overprovisioned memory**: Functions using far less memory than allocated
- **Excessive timeout**: Timeouts set much higher than actual execution time
- **Deprecated runtime**: Functions on end-of-life runtimes (Node.js 14, Python 3.7, etc.)
- **ARM64 migration**: x86 functions that could run on cheaper Graviton2
- **Excessive versions**: Functions retaining many old versions consuming storage
- **Provisioned concurrency waste**: Reserved concurrency with low utilization
- **Right-size memory**: Fine-tuned memory allocation based on actual usage
- **Function consolidation**: Many small functions that could merge
- **Scheduling optimization**: Periodic functions with inefficient schedules

### DynamoDB
- **Unused tables**: Zero reads and writes in 14-day monitoring period
- **Over-provisioned RCU/WCU**: Provisioned capacity far exceeding consumed throughput
- **Switch to On-Demand**: Low-utilization provisioned tables that would be cheaper on-demand
- **Switch to Provisioned**: Steady high-throughput on-demand tables that would be cheaper provisioned
- **Infrequent Access table class**: Storage-dominated tables where IA class saves on storage (accounting for higher IA throughput costs)
- **PITR review**: Point-in-time recovery enabled on low-traffic tables where on-demand backups may suffice
- **GSI optimization**: Redundant or underutilized Global Secondary Indexes
- **TTL suggestions**: Time-series/log/session data that could auto-expire to reduce storage
- **DAX caching**: Read-heavy tables that would benefit from DynamoDB Accelerator
- **Architecture optimization**: Partition key design, table consolidation, cold data offloading

### ELB (Elastic Load Balancing)
- **Idle load balancers**: Zero traffic and zero healthy targets over 14 days
- **Low-traffic load balancers**: Less than 100 requests/day — candidates for consolidation or removal
- **No registered targets**: Load balancers with zero target group registrations
- **Classic → ALB/NLB migration**: Classic Load Balancers that should upgrade to Application or Network LBs
- **Single-AZ load balancers**: LBs in only one availability zone, missing redundancy best practices
- **Orphaned target groups**: Target groups not attached to any load balancer
- **Architecture optimization**: Consolidation, routing, and scheduling improvements

### Full Audit
Runs all seven service audits in parallel, then consolidates the results:

1. **Parallel execution** — Launches EC2, RDS, S3, NAT, Lambda, DynamoDB, and ELB audits simultaneously with per-service progress tracking in the UI
2. **Deterministic dedup** — Removes exact duplicates and applies cross-category subsumption rules (e.g., an idle instance subsumes right-sizing and Graviton recommendations for the same resource)
3. **LLM dedup** — Claude identifies cross-service overlaps (e.g., stopping an EC2 instance also eliminates its NAT Gateway traffic savings)
4. **Cross-service synthesis** — Generates new recommendations only visible from the full audit view, such as multi-service Savings Plans, load balancer consolidation, and Lambda + DynamoDB provisioned throughput bundling

## Resolution tracking

Mark each recommendation as **Fixed** (implemented in AWS) or **Incorrect** (with an explanation). Resolved recommendations are filtered out by default but can be toggled back into view. Resolutions can be undone at any time.

**Carry-over across audits** — When you run a new audit, prior resolutions automatically apply to matching recommendations (matched by resource ID and category). This means you don't have to re-mark the same issues every time you re-audit.

## Prerequisites

- Node.js 18+
- An Anthropic API key
- AWS IAM credentials with read-only permissions (see below)

## Quick start

```bash
# Backend
cd backend
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, add an AWS account, and run an audit.

## Required IAM Policy

Create an IAM user with this policy (all read-only):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeVolumes",
        "ec2:DescribeAddresses",
        "ec2:DescribeRegions",
        "ec2:DescribeNatGateways",
        "ec2:DescribeVpcEndpoints",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "ce:GetCostAndUsage",
        "ce:GetSavingsPlansCoverage",
        "pricing:GetProducts",
        "sts:GetCallerIdentity",
        "rds:DescribeDBInstances",
        "rds:DescribeDBClusters",
        "rds:DescribeDBSnapshots",
        "rds:DescribeDBClusterSnapshots",
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetLifecycleConfiguration",
        "s3:GetBucketTagging",
        "s3:GetIntelligentTieringConfiguration",
        "s3:ListBucketMultipartUploads",
        "lambda:ListFunctions",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListVersionsByFunction",
        "lambda:ListAliases",
        "lambda:ListProvisionedConcurrencyConfigs",
        "dynamodb:ListTables",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:ListTagsOfResource",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:DescribeTags",
        "elasticloadbalancing:DescribeInstanceHealth"
      ],
      "Resource": "*"
    }
  ]
}
```

## Architecture

Each of the seven audit types follows a three-layer pattern:

1. **Collector** — Calls AWS APIs (describe/list calls, CloudWatch metrics, Cost Explorer) and returns structured data
2. **Analyzer** — Hybrid analysis: deterministic rules catch clear-cut savings, then Claude AI handles judgment-based recommendations (architecture, caching, consolidation)
3. **Audit Runner** — Orchestrates the flow: decrypt credentials → collect → analyze → carry over prior resolutions → store results in SQLite

The **Full Audit** runner acts as a meta-orchestrator — it launches all seven service runners in parallel, waits for completion, then runs a multi-pass deduplication and cross-service synthesis pipeline.

Audit types self-register via a registry pattern — adding a new service requires no changes to existing code. Just create a collector, analyzer, and runner that calls `registerAuditType()`, plus a frontend registration that calls `registerAuditUI()`.

## How it works

1. You add AWS account credentials through the web UI (encrypted at rest with AES-256-GCM)
2. Trigger an audit — the backend calls AWS APIs to gather service-specific data (describe calls, CloudWatch metrics, Cost Explorer billing data)
3. Deterministic rules flag clear savings (unused resources, over-provisioning, generation upgrades), then that data is sent to Claude for judgment-based analysis (architecture improvements, caching opportunities, consolidation)
4. Claude returns structured JSON recommendations stored in SQLite and displayed in the UI with estimated monthly savings
5. You review recommendations and mark them as Fixed or Incorrect — these resolutions persist and carry over to future audit runs
