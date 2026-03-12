# AWS Cost Saver

Analyzes your AWS EC2 instances for cost savings opportunities using Claude AI. Manage multiple AWS accounts through a web UI, run audits, and get actionable recommendations with estimated savings.

## What it checks

- **Right-sizing**: Instances with low CPU/network usage that could use smaller types
- **Idle instances**: Running instances with near-zero utilization
- **Old generations**: m4, c4, t2, etc. that should upgrade to current-gen for better price/performance
- **Stopped instances**: Still incurring EBS costs
- **Orphan EBS volumes**: Unattached volumes you're paying for
- **Idle Elastic IPs**: Unassociated EIPs costing ~$3.65/month each
- **Reserved Instances / Savings Plans**: Consistent usage that would benefit from commitments

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
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
        "ce:GetCostAndUsage",
        "ce:GetSavingsPlansCoverage",
        "pricing:GetProducts",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

## How it works

1. You add AWS account credentials through the web UI (encrypted at rest with AES-256-GCM)
2. Trigger an audit - the backend calls AWS APIs to gather EC2, CloudWatch, Cost Explorer, and Pricing data
3. That structured data is sent to Claude, which analyzes it as a cost optimization expert
4. Claude returns structured JSON recommendations stored in SQLite and displayed in the UI
