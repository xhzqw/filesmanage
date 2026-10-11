package ports
import("context";"filesmanage/internal/domain";"time")
type LifecycleStatisticsStore interface{
 LifecycleStatistics(context.Context,time.Time)(domain.LifecycleStatistics,error)
}
