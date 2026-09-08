# Overview

`OpenSearch` is an open-source, distributed search and analytics engine built on `Apache Lucene`. It stores `JSON` documents and provides `REST APIs` for indexing, searching, and analyzing data.

```text
OpenSearch
├── Document storage
├── Full-text and structured search
├── Real-time analytics
└── Distributed execution
```

Its main strength is the combination of multiple capabilities within one distributed system:

- **Search-oriented data structures** provide fast full-text search and relevance scoring.
    
- **Aggregations** analyze large collections of documents.
    
- **Sharding** distributes storage and execution across multiple nodes.
    
- **Replication** improves availability and search capacity.
    
- **Horizontal scalability** allows the cluster to grow by adding nodes.

Compared with a relational database, OpenSearch provides more advanced full-text search but does not provide the same relational and transactional guarantees. Compared with Apache Lucene alone, OpenSearch adds clustering, distribution, replication, security, and REST APIs.

Therefore, OpenSearch is particularly suitable for search engines, log analytics, application monitoring, and observability workloads.

# Architecture:

## Properties

This section introduces the fundamental concepts that should be understood before studying the OpenSearch architecture in greater detail.

```
OpenSearch
│
├── Java-based process
├── Containerized distribution
├── Deployment hierarchy
└── Identical nodes differentiated by roles
```

### Java-based process

OpenSearch is a Java-based application. Its compiled code is executed by the JVM, which is included in the bundled Java runtime.

Visualization:
```
Java runtime
└── Java Virtual Machine
     └── Compiled OpenSearch code
```

### Containerized distribution

The `Java runtime`, `JVM`, and `compiled OpenSearch code` are packaged into the official `Docker image`:

```
opensearchproject/opensearch
```

Each container created from this image normally runs one OpenSearch node.

### Deployment hierarchy

An OpenSearch node is a running application instance, not a physical machine or Kubernetes node.

In a standalone Docker environment:

```
Physical machine or VM
└── Docker container
    └── OpenSearch process
        └── OpenSearch node
```

In a Kubernetes environment:

```
Kubernetes cluster
│
├── Kubernetes Node A
│   └── Pod: opensearch-0
│       └── Container
│           └── OpenSearch Node 1
│
└── Kubernetes Node B
    └── Pod: opensearch-1
        └── Container
            └── OpenSearch Node 2
```

A Kubernetes node provides the physical or virtual computing resources. A Pod contains the OpenSearch container, and the container runs the OpenSearch node.

### Identical nodes differentiated by roles

All nodes run the same OpenSearch software. Their responsibilities are differentiated through assigned roles, such as `cluster_manager`, `data`, and `ingest`.

In another words, every nodes are established from the same `docker image`: `opensearchproject/opensearch`, but they are differentiated by roles.

Visualization:
```
OS-node-1
├── node.name = os-1
├── roles = [cluster_manager]
└── cluster.name = my-cluster

OS-node-2
├── node.name = os-2
├── roles = [data]
└── cluster.name = my-cluster

OS-node-3
├── node.name = os-3
├── roles = [ingest]
└── cluster.name = my-cluster
```

## Data model

An index can be understood from two different perspectives:

```
Index
│
├── Logical view
│   └── Index → Documents → Fields
│
└── Distributed storage view
    └── Index → Primary shards → Documents → Fields
```

### Logical view

From the user's perspective, an index is a collection of related documents, and each document contains multiple fields.

```
Index: products
│
├── Document 1
│   ├── name  = "iPhone Pro Camera"
│   ├── brand = "Apple"
│   └── price = 35000000
│
└── Document 2
    ├── name  = "Galaxy Ultra"
    ├── brand = "Samsung"
    └── price = 30000000
```

This is the view exposed through the OpenSearch APIs:

```
Index
└── Documents
    └── Fields
```

### Distributed storage view

Internally, an index is horizontally partitioned into primary shards. Each document is routed to exactly one primary shard.

The shards are then allocated across OpenSearch data nodes. Replica shards contain redundant copies of the same document partitions.

```text
Index: products

                         NODE PLACEMENT
              Node A          Node B          Node C
          ┌──────────────┬──────────────┬──────────────┐
Shard 0   │ Primary S0   │              │ Replica S0   │
          │ [D1, D4]     │              │ [D1, D4]     │
          ├──────────────┼──────────────┼──────────────┤
Shard 1   │ Replica S1   │ Primary S1   │              │
          │ [D2, D5]     │ [D2, D5]     │              │
          ├──────────────┼──────────────┼──────────────┤
Shard 2   │              │ Replica S2   │ Primary S2   │
          │              │ [D3, D6]     │ [D3, D6]     │
          └──────────────┴──────────────┴──────────────┘
    │
    └── SHARD PARTITIONS
```

```
Index: products
│
└── Primary shard set
    │
    ├── Primary Shard 0
    │   ├── Document 1
    │   │   ├── name
    │   │   ├── brand
    │   │   └── price
    │   │
    │   └── Document 4
    │       └── Fields
    │
    ├── Primary Shard 1
    │   ├── Document 2
    │   │   └── Fields
    │   │
    │   └── Document 5
    │       └── Fields
    │
    └── Primary Shard 2
        ├── Document 3
        │   └── Fields
        │
        └── Document 6
            └── Fields
```

The rows represent the document partitions, while the columns represent the nodes on which those partitions are allocated.

For example, documents `D1` and `D4` belong to Shard 0. Its primary copy is allocated to Node A, while its replica copy is allocated to Node C.

Therefore, the index is partitioned by shards, not by nodes:

```text
Index
└── partitioned into shards
    └── allocated across nodes
```

### Internal data representations

Inside each shard, the same logical documents are represented through different data structures.

```
Primary shard
└── Documents
    │
    ├── _source
    │   └── Original JSON documents
    │
    ├── Inverted index
    │   └── Search-oriented representation
    │
    └── Doc values
        └── Analytics-oriented representation
```

Therefore, OpenSearch organizes data in two directions:

```
Horizontal partitioning
└── Documents are distributed across primary shards

Purpose-oriented representation
└── The same documents are represented as:
    ├── _source
    ├── inverted index
    └── doc values
```

Within each shard, OpenSearch derives multiple physical representations from the same logical documents.

Consider the following documents:

```text
D1 = { name: "iPhone Camera", brand: "Apple",   price: 35 }
D2 = { name: "Galaxy Camera", brand: "Samsung", price: 30 }
D3 = { name: "iPhone",        brand: "Apple",   price: 18 }
```

OpenSearch reorganizes the same data according to three different access directions:

```text
Same logical documents
│
├── _source
│   │
│   └── DOCUMENT → ALL ORIGINAL FIELDS
│
│       D1 → { name: "iPhone Camera", brand: "Apple",   price: 35 }
│       D2 → { name: "Galaxy Camera", brand: "Samsung", price: 30 }
│       D3 → { name: "iPhone",        brand: "Apple",   price: 18 }
│
├── Inverted index
│   │
│   └── SEARCH TERM → MATCHING DOCUMENTS
│
│       iphone → [D1, D3]
│       camera → [D1, D2]
│       galaxy → [D2]
│
└── Doc values
    │
    └── FIELD → VALUE OF EACH DOCUMENT

        brand → [D1: Apple, D2: Samsung, D3: Apple]
        price → [D1: 35,    D2: 30,      D3: 18]
```

The three representations serve different access patterns:

- `_source` retrieves the complete original document.
    
- The inverted index finds documents from search terms.
    
- Doc values retrieve field values for sorting and aggregations.
    

They are not three independent documents. They are three physical layouts derived from the same logical document.

### Shard anatomy

Each OpenSearch shard is internally implemented as an independent Apache Lucene index. A Lucene index consists of multiple immutable segments.

```text
OpenSearch Shard
│
├── Lucene Index
│   │
│   ├── Segment 0
│   │   ├── Stored fields (_source)
│   │   ├── Inverted indexes
│   │   └── Doc values
│   │
│   ├── Segment 1
│   │   ├── Stored fields (_source)
│   │   ├── Inverted indexes
│   │   └── Doc values
│   │
│   └── ...
│
└── Translog
    └── Recent operations used for recovery
```

Each segment stores a subset of the shard's documents together with their search and analytical data structures. Because segments are immutable, smaller segments are periodically merged into larger ones.

The translog exists outside the Lucene index and records recent operations that have not yet been durably committed.

## Data placement in the deployment hierarchy

The data model describes how data is logically organized. The deployment hierarchy describes where the components responsible for that data are executed.

In Kubernetes, the complete hierarchy can be viewed as follows:

```text
Kubernetes cluster
│
├── Kubernetes Node A
│   └── Pod: opensearch-0
│       ├── OpenSearch container
│       │   └── OpenSearch Data Node 0
│       │       └── Allocated Primary Shard 0
│       │
│       └── Persistent Volume
│           └── Physical files of Primary Shard 0
│
├── Kubernetes Node B
│   └── Pod: opensearch-1
│       ├── OpenSearch container
│       │   └── OpenSearch Data Node 1
│       │       └── Allocated Primary Shard 1
│       │
│       └── Persistent Volume
│           └── Physical files of Primary Shard 1
│
└── Kubernetes Node C
    └── Pod: opensearch-2
        ├── OpenSearch container
        │   └── OpenSearch Data Node 2
        │       ├── Allocated Primary Shard 2
        │       └── Allocated Replica Shard 0
        │
        └── Persistent Volume
            ├── Physical files of Primary Shard 2
            └── Physical files of Replica Shard 0
```

A Kubernetes node is a physical or virtual machine that provides CPU, memory, networking, and storage access.

A Pod is scheduled onto a Kubernetes node. The Pod contains an OpenSearch container, and that container runs an OpenSearch process representing one OpenSearch node.

The OpenSearch node does not store an entire index. It stores only the shards allocated to it.

### Two placement decisions

Kubernetes and OpenSearch manage two different levels of placement:

```text
Kubernetes scheduler
└── places Pods on Kubernetes nodes

OpenSearch cluster manager
└── allocates shards to OpenSearch nodes
```

### Physical data persistence

Documents, inverted indexes, and doc values are physically stored as files belonging to their shards.

```text
Index
└── Shard
    └── Lucene data files
        ├── Original document data
        ├── Inverted indexes
        └── Doc values
```

These files should be stored in persistent volumes rather than relying exclusively on the container filesystem.

The OpenSearch process accesses the shard files through its mounted volume. If the container or Pod is recreated, the persistent volume allows the shard data to remain available.

Therefore, the responsibilities of each layer are:

| Layer             | Responsibility                                  |
| ----------------- | ----------------------------------------------- |
| Kubernetes node   | Provides physical computing resources           |
| Pod               | Hosts an OpenSearch workload                    |
| Container         | Runs the OpenSearch process                     |
| OpenSearch node   | Processes requests and manages allocated shards |
| Shard             | Stores a partition of an index                  |
| Persistent volume | Persists the physical shard files               |

## Distributed execution

OpenSearch distributes request execution across nodes and shards. The node that receives a client request acts as **the coordinating node** for that request.

**The coordinating node** does not necessarily store the requested data. Its responsibility is to route work to the appropriate shards and combine their results.

### Write execution

When a document is indexed, OpenSearch routes it to one primary shard based on its `_id` or custom routing value.

```text
Client
└── Coordinating Node
    └── Document routing
        └── Primary Shard
            ├── Update Lucene and translog
            └── Replicate the operation
                ├── Replica Shard 1
                └── Replica Shard 2
```

The write operation proceeds as follows:

1. The coordinating node determines the destination primary shard.
    
2. The request is forwarded to the OpenSearch node containing that shard.
    
3. The primary shard processes the operation.
    
4. The primary shard forwards the operation to its applicable replicas.
    
5. OpenSearch acknowledges the request after receiving confirmation from the required active shard copies.
    

The document is recorded in the translog and in-memory indexing buffers. It becomes searchable after a refresh creates a new Lucene segment.

### Search execution

A search request usually targets multiple shards because the documents of an index are distributed across them.

OpenSearch executes the request using a scatter-and-gather process:

```text
Client
└── Coordinating Node
    │
    ├── Shard 0 → Local Lucene search
    ├── Shard 1 → Local Lucene search
    └── Shard 2 → Local Lucene search
         │
         └── Partial results
              └── Coordinating Node
                   └── Final response
```

During the **query phase**, the coordinating node sends the query to one active copy of every relevant shard. This copy can be either the primary shard or one of its replicas.

Each shard searches its local Lucene segments and returns partial results such as document IDs, relevance scores, sort values, or aggregation results.

During the **reduce phase**, the coordinating node merges the partial shard results and determines the final result set.

During the **fetch phase**, the coordinating node retrieves `_source` only for the documents selected for the final response.

Therefore, distributed execution can be summarized as:

```text
Write request
└── routed to one primary shard
    └── replicated to its replica shards

Search request
└── distributed to all relevant shard groups
    └── partial results reduced by the coordinating node
```

# API templates

The following examples assume that the OpenSearch connection is configured through environment variables.

```bash
export OS_URL="https://localhost:9200"
export OS_USER="admin"

read -rsp "OpenSearch password: " OS_PASS
export OS_PASS
```

The `-k` option disables TLS certificate verification and should only be used in a local development environment.

## Inspect the cluster

### Check cluster health

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  "$OS_URL/_cluster/health?pretty"
```

### List OpenSearch nodes

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  "$OS_URL/_cat/nodes?v"
```

### Inspect shard allocation

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  "$OS_URL/_cat/shards?v"
```

## Create an index

The following template creates a `products` index with one primary shard and no replica shards.

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X PUT \
  "$OS_URL/products" \
  -H 'Content-Type: application/json' \
  -d '
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0
  },
  "mappings": {
    "properties": {
      "name": {
        "type": "text"
      },
      "brand": {
        "type": "keyword"
      },
      "price": {
        "type": "long"
      }
    }
  }
}'
```

`number_of_replicas: 0` is appropriate for a single-node lab. A multi-node deployment should normally use one or more replicas.

## Index documents

The `refresh=wait_for` parameter waits until the document becomes visible to search.

### Document 1

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X PUT \
  "$OS_URL/products/_doc/1?refresh=wait_for" \
  -H 'Content-Type: application/json' \
  -d '
{
  "name": "iPhone Pro Camera",
  "brand": "Apple",
  "price": 35000000
}'
```

### Document 2

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X PUT \
  "$OS_URL/products/_doc/2?refresh=wait_for" \
  -H 'Content-Type: application/json' \
  -d '
{
  "name": "Galaxy Ultra Camera",
  "brand": "Samsung",
  "price": 30000000
}'
```

### Document 3

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X PUT \
  "$OS_URL/products/_doc/3?refresh=wait_for" \
  -H 'Content-Type: application/json' \
  -d '
{
  "name": "iPhone Standard",
  "brand": "Apple",
  "price": 18000000
}'
```

## Retrieve a document

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  "$OS_URL/products/_doc/1?pretty"
```

Unlike search, retrieving a document by ID is real-time by default and does not require a refresh.

## Update a document

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_update/1?refresh=wait_for" \
  -H 'Content-Type: application/json' \
  -d '
{
  "doc": {
    "price": 34000000
  }
}'
```

## Search documents

### Full-text search

The `match` query analyzes the input text before searching the inverted index.

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '
{
  "query": {
    "match": {
      "name": "iphone camera"
    }
  }
}'
```

### Exact-term search

The `term` query searches for an exact value and is suitable for the `keyword` field.

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '
{
  "query": {
    "term": {
      "brand": "Apple"
    }
  }
}'
```

### Range search

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '
{
  "query": {
    "range": {
      "price": {
        "gte": 30000000
      }
    }
  }
}'
```

### Boolean query

The `must` clause contributes to relevance scoring, while `filter` clauses restrict the result set without contributing to the score.

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '
{
  "query": {
    "bool": {
      "must": [
        {
          "match": {
            "name": "iphone camera"
          }
        }
      ],
      "filter": [
        {
          "term": {
            "brand": "Apple"
          }
        },
        {
          "range": {
            "price": {
              "gte": 30000000
            }
          }
        }
      ]
    }
  }
}'
```

## Analyze documents

### Metric aggregation

The following aggregation calculates the average product price.

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '
{
  "size": 0,
  "aggs": {
    "average_price": {
      "avg": {
        "field": "price"
      }
    }
  }
}'
```

### Bucket aggregation

The following aggregation groups documents by brand.

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X POST \
  "$OS_URL/products/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '
{
  "size": 0,
  "aggs": {
    "products_by_brand": {
      "terms": {
        "field": "brand"
      }
    }
  }
}'
```

## Delete a document

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X DELETE \
  "$OS_URL/products/_doc/3?refresh=wait_for"
```

## Delete the index

```bash
curl -ksS \
  -u "$OS_USER:$OS_PASS" \
  -X DELETE \
  "$OS_URL/products"
```

---
