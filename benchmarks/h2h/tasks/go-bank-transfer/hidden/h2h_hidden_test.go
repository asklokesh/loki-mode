package tests

import (
	"errors"
	"reflect"
	"testing"

	"example.com/bank/account"
	"example.com/bank/ledger"
)

func bankWith(t *testing.T, accts ...*account.Account) *ledger.Ledger {
	t.Helper()
	l := ledger.New()
	for _, a := range accts {
		if err := l.Open(a); err != nil {
			t.Fatal(err)
		}
	}
	return l
}

type snapshot struct {
	balance int64
	history []account.Entry
}

func snap(a *account.Account) snapshot {
	return snapshot{balance: a.Balance, history: append([]account.Entry(nil), a.History...)}
}

func assertUnchanged(t *testing.T, a *account.Account, before snapshot) {
	t.Helper()
	if a.Balance != before.balance {
		t.Fatalf("%s balance changed from %d to %d on a failed transfer", a.ID, before.balance, a.Balance)
	}
	if len(a.History) != len(before.history) || (len(a.History) > 0 && !reflect.DeepEqual(a.History, before.history)) {
		t.Fatalf("%s history changed on a failed transfer: %+v", a.ID, a.History)
	}
}

func TestHiddenTransferMovesMoney(t *testing.T) {
	a, b := account.New("a", "ann", 1000), account.New("b", "bob", 50)
	l := bankWith(t, a, b)
	if err := l.Transfer("a", "b", 300, "lunch"); err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	if a.Balance != 700 || b.Balance != 350 {
		t.Fatalf("balances = %d, %d, want 700, 350", a.Balance, b.Balance)
	}
	if l.Total() != 1050 {
		t.Fatalf("Total = %d, want 1050", l.Total())
	}
}

func TestHiddenTransferHistoryEntries(t *testing.T) {
	a, b := account.New("a", "ann", 1000), account.New("b", "bob", 50)
	l := bankWith(t, a, b)
	if err := a.Deposit(10, "cash"); err != nil {
		t.Fatal(err)
	}
	if err := l.Transfer("a", "b", 300, "lunch"); err != nil {
		t.Fatalf("Transfer: %v", err)
	}
	wantA := []account.Entry{
		{Kind: "deposit", Amount: 10, Memo: "cash", BalanceAfter: 1010},
		{Kind: "transfer-out", Amount: -300, Memo: "lunch", BalanceAfter: 710, Counterparty: "b"},
	}
	wantB := []account.Entry{
		{Kind: "transfer-in", Amount: 300, Memo: "lunch", BalanceAfter: 350, Counterparty: "a"},
	}
	if !reflect.DeepEqual(a.History, wantA) {
		t.Fatalf("a.History = %+v, want %+v", a.History, wantA)
	}
	if !reflect.DeepEqual(b.History, wantB) {
		t.Fatalf("b.History = %+v, want %+v", b.History, wantB)
	}
}

func TestHiddenDepositEntryHasNoCounterparty(t *testing.T) {
	a := account.New("a", "ann", 0)
	if err := a.Deposit(5, "x"); err != nil {
		t.Fatal(err)
	}
	if a.History[0].Counterparty != "" {
		t.Fatalf("deposit Counterparty = %q, want empty", a.History[0].Counterparty)
	}
}

func TestHiddenTransferInvalidAmount(t *testing.T) {
	a, b := account.New("a", "ann", 1000), account.New("b", "bob", 0)
	l := bankWith(t, a, b)
	sa, sb := snap(a), snap(b)
	for _, c := range []int64{0, -5} {
		if err := l.Transfer("a", "b", c, ""); !errors.Is(err, ledger.ErrInvalidAmount) {
			t.Fatalf("Transfer(%d) err = %v, want ErrInvalidAmount", c, err)
		}
	}
	assertUnchanged(t, a, sa)
	assertUnchanged(t, b, sb)
}

func TestHiddenTransferSameAccount(t *testing.T) {
	a := account.New("a", "ann", 1000)
	l := bankWith(t, a)
	sa := snap(a)
	if err := l.Transfer("a", "a", 10, ""); !errors.Is(err, ledger.ErrSameAccount) {
		t.Fatalf("err = %v, want ErrSameAccount", err)
	}
	assertUnchanged(t, a, sa)
}

func TestHiddenTransferUnknownAccount(t *testing.T) {
	a := account.New("a", "ann", 1000)
	l := bankWith(t, a)
	sa := snap(a)
	if err := l.Transfer("a", "zz", 10, ""); !errors.Is(err, ledger.ErrUnknownAccount) {
		t.Fatalf("unknown destination err = %v, want ErrUnknownAccount", err)
	}
	if err := l.Transfer("zz", "a", 10, ""); !errors.Is(err, ledger.ErrUnknownAccount) {
		t.Fatalf("unknown source err = %v, want ErrUnknownAccount", err)
	}
	assertUnchanged(t, a, sa)
}

func TestHiddenTransferInsufficientFunds(t *testing.T) {
	a, b := account.New("a", "ann", 100), account.New("b", "bob", 0)
	l := bankWith(t, a, b)
	sa, sb := snap(a), snap(b)
	if err := l.Transfer("a", "b", 101, ""); !errors.Is(err, ledger.ErrInsufficientFunds) {
		t.Fatalf("err = %v, want ErrInsufficientFunds", err)
	}
	assertUnchanged(t, a, sa)
	assertUnchanged(t, b, sb)
	if err := l.Transfer("a", "b", 100, ""); err != nil {
		t.Fatalf("transferring the whole balance: %v", err)
	}
	if a.Balance != 0 {
		t.Fatalf("balance = %d, want 0", a.Balance)
	}
}

func TestHiddenTransferHonoursOverdraft(t *testing.T) {
	a, b := account.New("a", "ann", 100), account.New("b", "bob", 0)
	a.OverdraftLimit = 250
	l := bankWith(t, a, b)
	if err := l.Transfer("a", "b", 350, "big"); err != nil {
		t.Fatalf("transfer to exactly -OverdraftLimit: %v", err)
	}
	if a.Balance != -250 || b.Balance != 350 {
		t.Fatalf("balances = %d, %d, want -250, 350", a.Balance, b.Balance)
	}
	sa, sb := snap(a), snap(b)
	if err := l.Transfer("a", "b", 1, ""); !errors.Is(err, ledger.ErrInsufficientFunds) {
		t.Fatalf("err = %v, want ErrInsufficientFunds", err)
	}
	assertUnchanged(t, a, sa)
	assertUnchanged(t, b, sb)
}

func TestHiddenTransferErrorPrecedence(t *testing.T) {
	a := account.New("a", "ann", 0)
	l := bankWith(t, a)
	if err := l.Transfer("x", "x", 0, ""); !errors.Is(err, ledger.ErrInvalidAmount) {
		t.Fatalf("invalid amount must win: err = %v", err)
	}
	if err := l.Transfer("x", "x", 10, ""); !errors.Is(err, ledger.ErrSameAccount) {
		t.Fatalf("same account must beat unknown account: err = %v", err)
	}
	if err := l.Transfer("a", "nope", 10, ""); !errors.Is(err, ledger.ErrUnknownAccount) {
		t.Fatalf("unknown account must beat insufficient funds: err = %v", err)
	}
}

func TestHiddenTransferErrorsAreDistinct(t *testing.T) {
	errs := []error{ledger.ErrInvalidAmount, ledger.ErrSameAccount, ledger.ErrUnknownAccount, ledger.ErrInsufficientFunds}
	for i, e := range errs {
		if e == nil {
			t.Fatalf("error %d is nil", i)
		}
		for j, f := range errs {
			if i != j && errors.Is(e, f) {
				t.Fatalf("errors %d and %d are not distinct", i, j)
			}
		}
	}
}
