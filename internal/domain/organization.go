package domain

// Department is an organizational unit in a cycle-guarded tree.
type Department struct {
	ID, Name string
	ParentID *string
}

// Workgroup is a grantable subject inside an optional department.
type Workgroup struct {
	ID, Name     string
	DepartmentID *string
}
