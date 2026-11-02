package tests

import (
	"errors"
	"reflect"
	"testing"

	"example.com/bank/account"
	"example.com/bank/ledger"
)

func TestDepositAndWithdraw(t *testing.T) {
	a := account.New("a1", "ann", 1000)
	if err := a.Deposit(500, "pay"); err != nil {
		t.Fatal(err)
	}
	if err := a.Withdraw(200, "rent"); err != nil {
		t.Fatal(err)
	}
	if a.Balance != 1300 {
		t.Fatalf("Balance = %d, want 1300", a.Balance)
	}
	want := []account.Entry{
		{Kind: "deposit", Amount: 500, Memo: "pay", BalanceAfter: 1500},
		{Kind: "withdrawal", Amount: -200, Memo: "rent", BalanceAfter: 1300},
	}
	if !reflect.DeepEqual(a.History, want) {
		t.Fatalf("History = %+v, want %+v", a.History, want)
	}
}

func TestWithdrawHonoursOverdraft(t *testing.T) {
	a := account.New("a1", "ann", 100)
	a.OverdraftLimit = 50
	if err := a.Withdraw(150, ""); err != nil {
		t.Fatalf("withdrawing to -50 with a 50 limit: %v", err)
	}
	if err := a.Withdraw(1, ""); !errors.Is(err, account.ErrOverdraft) {
		t.Fatalf("err = %v, want ErrOverdraft", err)
	}
}

func TestLedgerOpenAndGet(t *testing.T) {
	l := ledger.New()
	if err := l.Open(account.New("b", "bo", 10)); err != nil {
		t.Fatal(err)
	}
	if err := l.Open(account.New("a", "al", 20)); err != nil {
		t.Fatal(err)
	}
	if err := l.Open(account.New("a", "dup", 0)); !errors.Is(err, ledger.ErrDuplicateAccount) {
		t.Fatalf("err = %v, want ErrDuplicateAccount", err)
	}
	if got := l.IDs(); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("IDs = %v", got)
	}
	if a, ok := l.Get("a"); !ok || a.Owner != "al" {
		t.Fatalf("Get(a) = %+v, %v", a, ok)
	}
	if l.Total() != 30 {
		t.Fatalf("Total = %d, want 30", l.Total())
	}
}
