/**
 * Saga — multi-role agent module.
 *
 * Cluster Proposer (legacy, incremental — agent_actions → cluster proposals):
 *   runSaga(), SagaConfig, SAGA_DEFAULTS
 *   — maintains keyword_maps + keyword_map_clusters
 *
 * Cluster Builder (authoritative, full rebuild — 2-level brand→sub-product):
 *   runClusterBuilder(), ClusterBuilderConfig, CLUSTER_BUILDER_DEFAULTS
 *   — pulls keywords from every source for a site, classifies via Sonnet
 *     into brand → sub-product hierarchy, persists into keyword_maps
 *     (level 0 = brand, level 1 = sub-product) + cluster_pages.
 *
 * Aggregator (pipeline signal grouping):
 *   runSagaAggregator(), AggregatorResult
 *   — groups Heimdall/Loki/Odin agent_actions into seo_opportunities rows
 *     so humans have a unified triage view
 *
 * Import from this index for all Saga functionality.
 */

export { runSaga, SAGA_DEFAULTS }                                     from './cluster'
export type { SagaConfig }                                            from './cluster'
export { runClusterBuilder, CLUSTER_BUILDER_DEFAULTS }                from './cluster-builder'
export type { ClusterBuilderConfig, ClusterBuilderResult }            from './cluster-builder'
export { runSagaAggregator }                                          from './aggregator'
export type { AggregatorResult }                                      from './aggregator'
