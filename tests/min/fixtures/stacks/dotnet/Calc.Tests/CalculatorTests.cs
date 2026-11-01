using Calc;
using Xunit;

namespace Calc.Tests;

public class CalculatorTests
{
    [Fact]
    public void AddsTwoNumbers() => Assert.Equal(5, Calculator.Add(2, 3));
}
