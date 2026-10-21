package application

import (
 "strings"
 "testing"
 "filesmanage/internal/ports"
)

func validCustomerForTest() CustomerWriteInput {
 return CustomerWriteInput{
  Name:"  测试有限公司  ",Category:"wholesale",Status:"active",CreditCode:" 914400000000000001 ",
  Profile:ports.CustomerProfile{Certificates:[]ports.CustomerCertificate{
   {Kind:"营业执照",Number:"9144",IssuedOn:"2025-01-01",ExpiresOn:"2030-12-31"},
  }},
 }
}

func TestCustomerValidationNormalizesWithoutChangingBusinessIdentity(t *testing.T) {
 in:=validCustomerForTest()
 if !validateCustomer(&in){t.Fatal("valid customer rejected")}
 if in.Name!="测试有限公司"||in.CreditCode!="914400000000000001"{t.Fatalf("normalization failed: %+v",in)}
 if len(in.Profile.Certificates[0].ID)==0{t.Fatal("certificate id must be generated")}
}

func TestCustomerValidationRejectsUntrustedFields(t *testing.T) {
 cases:=map[string]func(*CustomerWriteInput){
  "blank name":func(v *CustomerWriteInput){v.Name=" "},
  "oversize name":func(v *CustomerWriteInput){v.Name=strings.Repeat("甲",201)},
  "bad category":func(v *CustomerWriteInput){v.Category="unknown"},
  "bad status":func(v *CustomerWriteInput){v.Status="approved"},
  "invalid date":func(v *CustomerWriteInput){v.Profile.Certificates[0].IssuedOn="2026-02-31"},
  "backward certificate dates":func(v *CustomerWriteInput){v.Profile.Certificates[0].ExpiresOn="2020-01-01"},
  "duplicate certificate":func(v *CustomerWriteInput){cert:=v.Profile.Certificates[0];cert.ID="repeat";v.Profile.Certificates=[]ports.CustomerCertificate{cert,cert}},
  "oversize business scope":func(v *CustomerWriteInput){v.Profile.BusinessScope=strings.Repeat("a",4001)},
  "excess certificates":func(v *CustomerWriteInput){v.Profile.Certificates=make([]ports.CustomerCertificate,41)},
 }
 for name,mutate:=range cases{
  t.Run(name,func(t *testing.T){in:=validCustomerForTest();mutate(&in);if validateCustomer(&in){t.Fatalf("bad input accepted: %s",name)}})
 }
}
