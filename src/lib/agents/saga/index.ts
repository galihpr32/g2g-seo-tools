/**
 * Saga — dual-role agent module.
 *
 * Cluster (keyword universe curation):
 *   runSaga(), SagaConfig, SAGA_DEFAULTS
 *   — maintains keyword_maps + keyword_map_clusters
 *
 * Aggregator (pipeline signal grouping):
 *   runSagaAggregator(), AggregatorResult
 *   — groups Heimdall/Loki/Odin agent_actions into seo_opportunities rows
 *     so humans have a unified triage view
 *
 * Import from this index for all Saga functionality.
 */

export { runSaga, SAGA_DEFAULTS }        from './cluster'
export type { SagaConfig }               from './cluster'
export { runSagaAggregator }             from './aggregator'
export type { AggregatorResult }         from './aggregator'
